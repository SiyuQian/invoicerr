import { useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react"
import {
  useForm,
  useFormContext,
  useWatch,
  type DefaultValues,
  type FieldValues,
  type Path,
} from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { toast } from "sonner"
import SearchSelect from "@/components/search-input"
import { DatePicker } from "@/components/date-picker"
import { decimalsFor, fromMinor } from "@/components/documents/totals-calculator"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { useCompanies } from "@/hooks/queries/use-companies"
import { ApiError } from "@/hooks/use-api-query"
import { guardCloseAutoFocus } from "@/lib/close-auto-focus-guard"
import { fromCalendarDate, toCalendarDate } from "@/lib/calendar-date"
import type { MutationBody } from "@/types/project-reconciliation"
import { FormDialog } from "../../_shared/form-dialog"

export function useReconciliationCompany(companyId: string) {
  return useCompanies().activeCompanyId === companyId
}

// Controlled forms unmount on close and have no Radix DialogTrigger to restore focus to.
export function useReconciliationDialogFocus(companyId: string, fallbackSelector: string) {
  const scope = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const { activeCompanyId } = useCompanies()
  const activeCompany = useRef(activeCompanyId)
  activeCompany.current = activeCompanyId
  const captureOpener = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target.closest('[role="dialog"]')) return
    const menu = target.closest('[role="menu"]')
    const control = menu
      ? document.getElementById(menu.getAttribute("aria-labelledby") ?? "")
      : target.closest<HTMLElement>("button, a")
    if (control && scope.current?.contains(control)) opener.current = control
  }
  const restoreFocus = (event: Event) => {
    guardCloseAutoFocus(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    if (activeCompany.current !== companyId || !scope.current?.isConnected) return
    const available = (control: HTMLElement | null): control is HTMLElement =>
      !!control &&
      scope.current!.contains(control) &&
      !control.matches(":disabled") &&
      !control.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')
    if (available(opener.current)) opener.current.focus({ preventScroll: true })
    // CSS can prevent a connected, enabled opener from receiving focus.
    const active = document.activeElement
    if (active !== document.body && active?.isConnected) return
    const fallback = scope.current.querySelector<HTMLElement>(fallbackSelector)
    if (available(fallback)) fallback.focus({ preventScroll: true })
  }
  return { scope, captureOpener, restoreFocus }
}

export interface ReconciliationFormProps {
  companyId: string
  projectId: string
  versionToken: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
  onReload: () => Promise<string>
  unavailable?: string
}
export const nullableText = (max = 4000) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || null : value),
    z.string().min(1).max(max).nullable(),
  )
export const requiredText = (max = 4000) => z.string().trim().min(1).max(max)
export const nullableDate = z.iso.date().nullable()
export function minorAmountSchema(currency: string, nullable: boolean, positive = false) {
  const decimals = decimalsFor(currency)
  return z
    .string()
    .trim()
    .max(64)
    .transform((value, ctx) => {
      if (value === "" && nullable) return null
      const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
      if (!match || (match[2]?.length ?? 0) > decimals) {
        ctx.addIssue({ code: "custom", message: "projectReconciliation.workflow.invalidAmount" })
        return z.NEVER
      }
      const minor =
        BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0")
      if (minor > 2147483647n || (positive && minor === 0n)) {
        ctx.addIssue({ code: "custom", message: "projectReconciliation.workflow.invalidAmount" })
        return z.NEVER
      }
      return Number(minor)
    })
}
export const amountInput = (minor: number | null | undefined, currency: string) =>
  minor == null ? "" : fromMinor(minor, currency).toFixed(decimalsFor(currency))

export function useReconciliationForm<TFields extends FieldValues, TInput>(
  props: ReconciliationFormProps,
  initial: DefaultValues<TFields>,
  schema: z.ZodType<TInput>,
  mutate: (input: MutationBody<TInput>) => Promise<unknown>,
  prepare?: (versionToken: string) => Promise<void>,
) {
  const { activeCompanyId, activeRole } = useCompanies()
  const canWrite =
    activeCompanyId === props.companyId &&
    (activeRole === "OWNER" || activeRole === "ADMIN") &&
    !props.unavailable
  const form = useForm<TFields>({ defaultValues: initial })
  const values = useWatch({ control: form.control })
  const dirtyFields = form.formState.dirtyFields
  // Compare normalized DTOs against the same decision basis until an explicit reload.
  const comparisonSchema = useRef(schema)
  const openingVersion = useRef(props.versionToken)
  const comparison = comparisonSchema.current.safeParse(values)
  const signature = JSON.stringify(comparison.success ? comparison.data : values)
  const previous = useRef(signature)
  const attempt = useRef<MutationBody<TInput> | null>(null)
  const prepared = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [reloadFailed, setReloadFailed] = useState(false)
  const [freshVersion, setFreshVersion] = useState<string | null>(null)
  const rebasedVersion = useRef<string | null>(null)
  useEffect(() => {
    if (!freshVersion || props.versionToken !== freshVersion || rebasedVersion.current === freshVersion)
      return
    const refreshed = { ...initial }
    const current = form.getValues()
    // Allocation sets and selected matches are atomic arrays, never rebased by row index.
    for (const key of Object.keys(dirtyFields))
      if (Array.isArray(current[key])) Object.assign(refreshed, { [key]: current[key] })
    form.reset(refreshed, { keepDirtyValues: Object.keys(dirtyFields).length > 0 })
    comparisonSchema.current = schema
    rebasedVersion.current = freshVersion
  }, [freshVersion, props.versionToken, initial, schema, dirtyFields, form])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const conflict = error instanceof ApiError && error.status === 409
  useEffect(() => {
    if (previous.current === signature) return
    previous.current = signature
    form.clearErrors()
    attempt.current = null
    prepared.current = false
    if (!conflict) setError(null)
  }, [signature, conflict, form])
  const submit = form.handleSubmit(async (fields) => {
    if (!canWrite || pending || conflict || reloading) return
    // Saved retries must reach server idempotency even if live capacity has changed.
    if (!attempt.current) {
      const result = schema.safeParse(fields)
      if (!result.success) {
        for (const issue of result.error.issues)
          form.setError(issue.path.join(".") as Path<TFields>, {
            message: issue.message.startsWith("projectReconciliation.") ? t(issue.message) : issue.message,
          })
        return
      }
      comparisonSchema.current = schema
      previous.current = JSON.stringify(result.data)
      attempt.current = {
        ...result.data,
        expectedVersion: freshVersion ?? openingVersion.current,
        requestKey: crypto.randomUUID(),
      }
    }
    const currentAttempt = attempt.current
    setPending(true)
    setError(null)
    try {
      if (!prepared.current) {
        await prepare?.(currentAttempt.expectedVersion)
        prepared.current = true
      }
      if (!alive.current) return
      await mutate(currentAttempt)
      if (alive.current) {
        attempt.current = null
        prepared.current = false
        form.reset(initial)
        toast.success(i18nSaved())
        props.onOpenChange(false)
      }
    } catch (failure) {
      if (alive.current) setError(failure)
    } finally {
      if (alive.current) setPending(false)
    }
  })
  const { t } = useTranslation()
  const i18nSaved = () => t("projectReconciliation.workflow.saved")
  const reload = async () => {
    setReloading(true)
    setReloadFailed(false)
    try {
      const version = await props.onReload()
      if (!version) throw new Error("Missing aggregate version")
      if (alive.current) {
        setFreshVersion(version)
        attempt.current = null
        prepared.current = false
        comparisonSchema.current = schema
        setError(null)
      }
    } catch {
      if (alive.current) setReloadFailed(true)
    } finally {
      if (alive.current) setReloading(false)
    }
  }
  return {
    form,
    submit,
    error,
    pending,
    conflict,
    reloading,
    reloadFailed,
    reload,
    canWrite,
    retrying: !!attempt.current && !!error && !conflict,
    unavailable: props.unavailable,
    onCloseAutoFocus: props.onCloseAutoFocus,
    close: () => props.onOpenChange(false),
  }
}

type DialogState<T extends FieldValues> = {
  form: ReturnType<typeof useForm<T>>
  submit: React.FormEventHandler<HTMLFormElement>
  error: unknown
  pending: boolean
  conflict: boolean
  reloading: boolean
  reloadFailed: boolean
  reload: () => Promise<void>
  canWrite: boolean
  unavailable?: string
  close: () => void
  onCloseAutoFocus?: (event: Event) => void
}
export function MutationDialog<T extends FieldValues>({
  state,
  title,
  children,
  disabled = false,
  readOnly = false,
  actionLabel,
  formDataCy,
}: {
  state: DialogState<T>
  title: ReactNode
  children: ReactNode
  disabled?: boolean
  readOnly?: boolean
  actionLabel?: ReactNode
  formDataCy?: string
}) {
  const { t } = useTranslation()
  return (
    <Form {...state.form}>
      <FormDialog
        onCloseAutoFocus={state.onCloseAutoFocus}
        open
        onOpenChange={(open) => {
          if (!open) state.close()
        }}
        title={title}
        description={t("projectReconciliation.workflow.recordsOnly")}
        onSubmit={state.submit}
        formDataCy={formDataCy}
        footer={
          <>
            <Button type="button" variant="outline" onClick={state.close}>
              {t("projectReconciliation.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                readOnly || disabled || !state.canWrite || state.pending || state.conflict || state.reloading
              }
            >
              {actionLabel ?? t("projectReconciliation.workflow.save")}
            </Button>
          </>
        }
      >
        <fieldset
          disabled={readOnly || state.pending || state.reloading || !state.canWrite}
          className="min-w-0 space-y-4"
        >
          {children}
        </fieldset>
        {state.unavailable && (
          <div role="alert" className="mt-4 space-y-2 text-sm text-destructive">
            <p>{state.unavailable}</p>
            {!state.conflict && (
              <Button
                type="button"
                variant="outline"
                disabled={state.reloading}
                onClick={() => void state.reload()}
              >
                {t("projectReconciliation.reload")}
              </Button>
            )}
          </div>
        )}
        {!!state.error && (
          <div role="alert" className="mt-4 text-sm text-destructive">
            <p>{t(state.conflict ? "projectReconciliation.conflict" : "projectReconciliation.saveError")}</p>
            {state.error instanceof ApiError && <p>{state.error.message}</p>}
            {state.conflict && (
              <Button
                type="button"
                variant="outline"
                disabled={state.reloading}
                onClick={() => void state.reload()}
              >
                {t("projectReconciliation.reload")}
              </Button>
            )}
          </div>
        )}
        {state.reloadFailed && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {t("projectReconciliation.workflow.refreshFailed")}
          </p>
        )}
      </FormDialog>
    </Form>
  )
}
export function ReconciliationTextField({
  name,
  label,
  required = false,
  description,
  maxLength = 4000,
  disabled = false,
}: {
  name: string
  label: string
  required?: boolean
  description?: string
  maxLength?: number
  disabled?: boolean
}) {
  const { control } = useFormContext()
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel required={required} description={description}>
            {label}
          </FormLabel>
          <FormControl>
            <Input {...field} value={field.value ?? ""} maxLength={maxLength} disabled={disabled} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
export function ReconciliationDateField({
  name,
  label,
  placeholder,
}: {
  name: string
  label: string
  placeholder?: string
}) {
  const { control } = useFormContext()
  const { t } = useTranslation()
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="min-w-0">
          <FormLabel>{label}</FormLabel>
          <DatePicker
            value={fromCalendarDate(field.value)}
            onChange={(date) => field.onChange(toCalendarDate(date) ?? null)}
            placeholder={placeholder ?? t("projectReconciliation.workflow.unknownDate")}
            className="w-full min-w-0 max-w-full"
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => field.onChange(null)}>
            {t("projectReconciliation.workflow.clearDate")}
          </Button>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
export function ReconciliationChoiceField({
  name,
  label,
  options,
  disabled = false,
}: {
  name: string
  label: string
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  const { control } = useFormContext()
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <SearchSelect
              options={options.filter((x) => x.label.toLowerCase().includes(search.toLowerCase()))}
              allOptions={options}
              value={field.value ?? ""}
              onValueChange={(value) => field.onChange(String(value) || null)}
              onSearchChange={setSearch}
              searchPlaceholder={t("projectReconciliation.workflow.searchOptions")}
              disabled={disabled}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
export function ReconciliationCheckField({ name, label }: { name: string; label: string }) {
  const { control } = useFormContext()
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-start gap-3">
          <FormControl>
            <Checkbox
              checked={field.value === true}
              onCheckedChange={(value) => field.onChange(value === true)}
            />
          </FormControl>
          <div>
            <FormLabel>{label}</FormLabel>
            <FormMessage />
          </div>
        </FormItem>
      )}
    />
  )
}
