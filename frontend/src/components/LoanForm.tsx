import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import { centsToInput, todayIso } from '../money'
import { useAccounts, useLoanTypes } from '../queries'
import { useRun } from '../toast'
import type { Loan, LoanCreateBody, LoanDetailsInput, LoanPaymentBody, LoanUpdateBody } from '../types'
import { AccountSelect } from './selects'
import { Modal } from './ui'

function detailsOf(
  loanType: string,
  lender: string,
  original: string,
  residual: string,
  rate: string,
  interestBearing: boolean,
  minPayment: string,
  dueDay: string,
  creditLimit: string,
  reference: string,
  notes: string,
): LoanDetailsInput {
  return {
    loan_type: loanType,
    lender,
    original_principal: original || '0',
    residual: residual || '0',
    rate: rate || '0',
    is_interest_bearing: interestBearing,
    min_payment: minPayment || '0',
    due_day: Number(dueDay) || 0,
    credit_limit: creditLimit || '0',
    reference,
    notes,
  }
}

export function LoanFormModal({
  loan,
  onClose,
  onSaved,
}: {
  loan?: Loan
  onClose: () => void
  onSaved: (accountId: number) => void
}) {
  const run = useRun()
  const editing = loan != null
  const types = useLoanTypes().data?.types ?? []
  const accounts = (useAccounts().data ?? []).filter((a) => !a.is_loan)

  const [name, setName] = useState(loan?.name ?? '')
  const [owed, setOwed] = useState(loan ? centsToInput(-loan.opening_balance_cents) : '0')
  const [openingDate, setOpeningDate] = useState(loan?.opening_date ?? todayIso())
  const [isActive, setIsActive] = useState(loan?.is_active ?? true)
  const [loanType, setLoanType] = useState(loan?.loan_type ?? '')
  const [lender, setLender] = useState(loan?.lender ?? '')
  const [original, setOriginal] = useState(loan ? centsToInput(loan.original_principal_cents) : '0')
  const [residual, setResidual] = useState(loan ? centsToInput(loan.residual_cents) : '0')
  const [rate, setRate] = useState(loan ? centsToInput(loan.rate_bps) : '0')
  const [interestBearing, setInterestBearing] = useState(loan?.is_interest_bearing ?? false)
  const [minPayment, setMinPayment] = useState(loan ? centsToInput(loan.min_payment_cents) : '0')
  const [dueDay, setDueDay] = useState(loan && loan.due_day ? String(loan.due_day) : '')
  const [creditLimit, setCreditLimit] = useState(loan ? centsToInput(loan.credit_limit_cents) : '0')
  const [reference, setReference] = useState(loan?.reference ?? '')
  const [notes, setNotes] = useState(loan?.notes ?? '')

  const [disbursing, setDisbursing] = useState(false)
  const [disbAccount, setDisbAccount] = useState<number | null>(null)
  const [disbAmount, setDisbAmount] = useState('0')
  const [disbDate, setDisbDate] = useState(todayIso())
  const [disbDescription, setDisbDescription] = useState('')

  const effectiveType = loanType || (editing ? '' : (types[0]?.key ?? ''))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const details = detailsOf(
      effectiveType,
      lender,
      original,
      residual,
      rate,
      interestBearing,
      minPayment,
      dueDay,
      creditLimit,
      reference,
      notes,
    )
    if (editing) {
      const body: LoanUpdateBody = { name, owed, opening_date: openingDate || null, is_active: isActive, details }
      const result = await run(() => api.updateLoan(loan.account_id, body), `Saved ${name.trim()}`)
      if (result) onSaved(result.account_id)
      return
    }
    const useDisbursement = disbursing && disbAccount != null
    const body: LoanCreateBody = {
      name,
      owed,
      opening_date: openingDate || null,
      is_active: isActive,
      details,
      disbursement_account_id: useDisbursement ? disbAccount : null,
      disbursement_amount: useDisbursement ? disbAmount : '0',
      disbursement_date: useDisbursement ? disbDate || null : null,
      disbursement_description: useDisbursement ? disbDescription : '',
    }
    const result = await run(() => api.createLoan(body), `Added ${name.trim()}`)
    if (result) onSaved(result.account_id)
  }

  return (
    <Modal title={editing ? `Edit ${loan.name}` : 'Add loan'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div>
            <label htmlFor="loan-name">Name</label>
            <input
              id="loan-name"
              type="text"
              required
              autoFocus
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-type">Type</label>
            <select id="loan-type" value={effectiveType} onChange={(e) => setLoanType(e.target.value)}>
              {!editing && types.length === 0 && <option value="">Loading types…</option>}
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="loan-lender">Lender</label>
            <input
              id="loan-lender"
              type="text"
              maxLength={80}
              value={lender}
              onChange={(e) => setLender(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-owed">{editing ? 'Opening amount owed ($)' : 'Amount owed ($)'}</label>
            <input
              id="loan-owed"
              type="text"
              inputMode="decimal"
              value={owed}
              onChange={(e) => setOwed(e.target.value)}
            />
            <span className="small muted">
              {editing
                ? 'The debt as of the opening date; later transactions adjust the live balance.'
                : 'What you owe today. Payments you record later reduce it.'}
            </span>
          </div>
          <div>
            <label htmlFor="loan-original">Original principal ($)</label>
            <input
              id="loan-original"
              type="text"
              inputMode="decimal"
              value={original}
              onChange={(e) => setOriginal(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-residual">Residual / balloon ($)</label>
            <input
              id="loan-residual"
              type="text"
              inputMode="decimal"
              value={residual}
              onChange={(e) => setResidual(e.target.value)}
            />
            <span className="small muted">
              Part of the amount owed that a final payment settles (a lease buyout). Leave 0 for a loan that pays
              down to nothing.
            </span>
          </div>
          <div>
            <label htmlFor="loan-open-date">Opening date</label>
            <input
              id="loan-open-date"
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-rate">Interest rate (% per year)</label>
            <input
              id="loan-rate"
              type="text"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-min">Minimum payment ($)</label>
            <input
              id="loan-min"
              type="text"
              inputMode="decimal"
              value={minPayment}
              onChange={(e) => setMinPayment(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-due">Payment due day (1–31)</label>
            <input
              id="loan-due"
              type="number"
              min={1}
              max={31}
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-limit">Credit limit ($)</label>
            <input
              id="loan-limit"
              type="text"
              inputMode="decimal"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-ref">Reference</label>
            <input
              id="loan-ref"
              type="text"
              maxLength={80}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="field-full">
            <label htmlFor="loan-notes">Notes</label>
            <input id="loan-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <label className="check field-full">
            <input
              type="checkbox"
              checked={interestBearing}
              onChange={(e) => setInterestBearing(e.target.checked)}
            />{' '}
            This loan charges interest
          </label>
          {editing && (
            <label className="check field-full">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active —
              inactive loans are hidden from pickers but keep their history
            </label>
          )}
        </div>

        {!editing && (
          <div className="form-section">
            <h2>Where did the money go?</h2>
            <label className="check">
              <input type="checkbox" checked={disbursing} onChange={(e) => setDisbursing(e.target.checked)} /> The
              borrowed money landed in an account I track
            </label>
            {disbursing && (
              <div className="form-grid" style={{ marginTop: 12 }}>
                <div>
                  <label htmlFor="loan-disb-acc">Destination account</label>
                  <AccountSelect
                    id="loan-disb-acc"
                    accounts={accounts}
                    value={disbAccount}
                    onChange={setDisbAccount}
                    blank="Choose account…"
                  />
                </div>
                <div>
                  <label htmlFor="loan-disb-amount">Amount ($)</label>
                  <input
                    id="loan-disb-amount"
                    type="text"
                    inputMode="decimal"
                    value={disbAmount}
                    onChange={(e) => setDisbAmount(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="loan-disb-date">Date</label>
                  <input
                    id="loan-disb-date"
                    type="date"
                    value={disbDate}
                    onChange={(e) => setDisbDate(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="loan-disb-desc">Description</label>
                  <input
                    id="loan-disb-desc"
                    type="text"
                    maxLength={200}
                    value={disbDescription}
                    onChange={(e) => setDisbDescription(e.target.value)}
                  />
                </div>
              </div>
            )}
            <p className="small muted">
              A disbursement is booked as a transfer into the account, so the loan still shows exactly the amount owed
              you entered above.
            </p>
          </div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink" type="submit">
            {editing ? 'Save' : 'Add loan'}
          </button>
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function LoanPaymentModal({
  loan,
  onClose,
  onSaved,
}: {
  loan: Loan
  onClose: () => void
  onSaved: () => void
}) {
  const run = useRun()
  const accounts = (useAccounts().data ?? []).filter((a) => !a.is_loan && a.id !== loan.account_id)

  const [fromAccountId, setFromAccountId] = useState<number | null>(null)
  const [amount, setAmount] = useState(loan.min_payment_cents ? centsToInput(loan.min_payment_cents) : '')
  const [date, setDate] = useState(todayIso())
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: LoanPaymentBody = {
      from_account_id: fromAccountId,
      amount,
      date,
      description,
      notes: notes || null,
    }
    const result = await run(() => api.loanPayment(loan.account_id, body), `Payment to ${loan.name}`)
    if (result) onSaved()
  }

  return (
    <Modal title={`Record a payment — ${loan.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div>
            <label htmlFor="loan-pay-from">Pay from</label>
            <AccountSelect
              id="loan-pay-from"
              accounts={accounts}
              value={fromAccountId}
              onChange={setFromAccountId}
              blank="Choose account…"
            />
          </div>
          <div>
            <label htmlFor="loan-pay-amount">Amount ($)</label>
            <input
              id="loan-pay-amount"
              type="text"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="loan-pay-date">Date</label>
            <input id="loan-pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="loan-pay-desc">Description</label>
            <input
              id="loan-pay-desc"
              type="text"
              maxLength={200}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field-full">
            <label htmlFor="loan-pay-notes">Notes</label>
            <input id="loan-pay-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <p className="small muted">
          This writes both sides of the payment as one transfer — money leaves the account you pick and the loan balance
          drops by the same amount.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink" type="submit">
            Record payment
          </button>
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
