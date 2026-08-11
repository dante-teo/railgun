import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useState } from 'react'

import { InlineError, SettingsDetail, SettingsLoading, SettingsSection } from './SettingsChrome'
import { SettingsAnimatedList, SettingsCrossfade, SettingsListItem } from './SettingsMotion'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { ManagedSkill, SkillSummary } from '@/lib/skill-api'

const skillNamePattern = /^[a-z0-9-]{1,64}$/

interface SkillDraft {
  allowModelInvocation: boolean
  body: string
  description: string
  name: string
  original?: ManagedSkill
}

export function SkillsSettings({
  registerSaveBeforeNavigation
}: {
  registerSaveBeforeNavigation: (save?: () => Promise<boolean>) => void
}): React.JSX.Element {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [mutationError, setMutationError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [draft, setDraft] = useState<SkillDraft>()
  const [validation, setValidation] = useState<Record<string, string>>({})
  const [deleteCandidate, setDeleteCandidate] = useState<SkillSummary>()
  const [enteringSkillName, setEnteringSkillName] = useState<string>()
  const [exitingSkillNames, setExitingSkillNames] = useState<ReadonlySet<string>>(new Set())
  const [skillMotionRevision, setSkillMotionRevision] = useState(0)

  const requestSkills = useCallback((): void => {
    void window.railgun.skills.list().then(
      (records) => {
        setSkills(records)
        setLoading(false)
      },
      () => {
        setLoadError('Could not load managed skills.')
        setLoading(false)
      }
    )
  }, [])

  useEffect(requestSkills, [requestSkills])

  const load = useCallback((): void => {
    setLoading(true)
    setLoadError(undefined)
    requestSkills()
  }, [requestSkills])

  const visibleSkills = deferredQuery
    ? skills.filter(({ name, description }) =>
        `${name} ${description}`.toLowerCase().includes(deferredQuery)
      )
    : skills

  const openEdit = async (summary: SkillSummary): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMutationError(undefined)
    try {
      const skill = await window.railgun.skills.get(summary.name)
      setDraft({ ...skill, original: skill })
    } catch {
      setMutationError(`Could not load “${summary.name}”.`)
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (!draft) return true
    const nextValidation: Record<string, string> = {
      ...(!skillNamePattern.test(draft.name)
        ? { name: 'Use 1–64 lowercase letters, numbers, or hyphens.' }
        : {}),
      ...(!draft.description.trim() ? { description: 'Description is required.' } : {})
    }
    setValidation(nextValidation)
    if (Object.keys(nextValidation).length > 0) return false

    setBusy(true)
    setMutationError(undefined)
    try {
      const input = {
        description: draft.description.trim(),
        body: draft.body,
        allowModelInvocation: draft.allowModelInvocation
      }
      const saved = draft.original
        ? await window.railgun.skills.update(draft.original.name, input)
        : await window.railgun.skills.create({ name: draft.name, ...input })
      setSkills((current) =>
        [...current.filter(({ name }) => name !== saved.name), saved].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      )
      if (
        !draft.original &&
        (!deferredQuery ||
          `${saved.name} ${saved.description}`.toLowerCase().includes(deferredQuery))
      ) {
        setEnteringSkillName(saved.name)
      }
      setSkillMotionRevision((current) => current + 1)
      setDraft(undefined)
      return true
    } catch {
      setMutationError('The skill could not be saved. Your draft is still here.')
      return false
    } finally {
      setBusy(false)
    }
  }, [deferredQuery, draft])

  useEffect(() => {
    registerSaveBeforeNavigation(saveDraft)
    return () => registerSaveBeforeNavigation(undefined)
  }, [registerSaveBeforeNavigation, saveDraft])

  const deleteSkill = async (): Promise<void> => {
    if (!deleteCandidate || busy) return
    setBusy(true)
    setMutationError(undefined)
    try {
      await window.railgun.skills.delete(deleteCandidate.name)
      const deletedName = deleteCandidate.name
      setDeleteCandidate(undefined)
      setExitingSkillNames((current) => new Set([...current, deletedName]))
    } catch {
      setMutationError('The skill could not be deleted. The list was not changed.')
    } finally {
      setBusy(false)
    }
  }

  const finishSkillExit = (skillName: string): void => {
    setSkills((current) => current.filter(({ name }) => name !== skillName))
    setExitingSkillNames(
      (current) => new Set([...current].filter((currentName) => currentName !== skillName))
    )
    setSkillMotionRevision((current) => current + 1)
  }

  const presentationState = loading ? 'loading' : loadError ? 'error' : 'ready'
  const interactionLocked = busy || exitingSkillNames.size > 0

  return (
    <SettingsDetail
      description="Create Markdown playbooks Railgun can invoke or you can call explicitly."
      title="Skills"
    >
      <SettingsSection
        action={
          <Button
            disabled={interactionLocked}
            onClick={() =>
              setDraft({
                name: '',
                description: '',
                body: '',
                allowModelInvocation: true
              })
            }
            size="sm"
          >
            <Plus data-icon="inline-start" />
            New Skill
          </Button>
        }
        description="Skill names are fixed after creation."
        title="Managed Skills"
      >
        <FieldGroup>
          <Field>
            <FieldLabel className="sr-only" htmlFor="skill-search">
              Search skills
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-8"
                disabled={exitingSkillNames.size > 0}
                id="skill-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search skills"
                type="search"
                value={query}
              />
            </div>
          </Field>
        </FieldGroup>
        {mutationError ? <InlineError>{mutationError}</InlineError> : null}
        <SettingsCrossfade stateKey={presentationState}>
          {loading ? (
            <SettingsLoading label="Skills are loading" />
          ) : loadError ? (
            <div className="flex items-center justify-between gap-3">
              <InlineError>{loadError}</InlineError>
              <Button onClick={load} variant="outline">
                Retry
              </Button>
            </div>
          ) : visibleSkills.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{query ? 'No matching skills' : 'No managed skills'}</EmptyTitle>
                <EmptyDescription>
                  {query ? 'Try a different search.' : 'Create a Markdown skill to get started.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SettingsAnimatedList ariaLabel="Managed skills" motionRevision={skillMotionRevision}>
              {visibleSkills.map((skill) => (
                <SettingsListItem
                  entering={enteringSkillName === skill.name}
                  exiting={exitingSkillNames.has(skill.name)}
                  itemKey={skill.name}
                  key={skill.name}
                  onExitComplete={() => finishSkillExit(skill.name)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium">{skill.name}</span>
                      <Badge variant="outline">
                        {skill.allowModelInvocation ? 'Automatic' : 'Manual only'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      aria-label={`Edit ${skill.name}`}
                      disabled={interactionLocked}
                      onClick={() => void openEdit(skill)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={`Delete ${skill.name}`}
                      disabled={interactionLocked}
                      onClick={() => setDeleteCandidate(skill)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </SettingsListItem>
              ))}
            </SettingsAnimatedList>
          )}
        </SettingsCrossfade>
      </SettingsSection>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDraft(undefined)
            setValidation({})
            setMutationError(undefined)
          }
        }}
        open={Boolean(draft)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft?.original ? 'Edit Skill' : 'New Skill'}</DialogTitle>
            <DialogDescription>
              Markdown is stored as a managed SKILL.md file with private permissions.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <FieldGroup>
              <Field
                data-disabled={Boolean(draft.original)}
                data-invalid={Boolean(validation.name)}
              >
                <FieldLabel htmlFor="skill-name">Name</FieldLabel>
                <Input
                  aria-invalid={Boolean(validation.name)}
                  disabled={Boolean(draft.original)}
                  id="skill-name"
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, name: event.target.value } : current
                    )
                  }
                  placeholder="release-review"
                  value={draft.name}
                />
                <FieldDescription>Lowercase letters, numbers, and hyphens only.</FieldDescription>
                <FieldError>{validation.name}</FieldError>
              </Field>
              <Field data-invalid={Boolean(validation.description)}>
                <FieldLabel htmlFor="skill-description">Description</FieldLabel>
                <Input
                  aria-invalid={Boolean(validation.description)}
                  id="skill-description"
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, description: event.target.value } : current
                    )
                  }
                  value={draft.description}
                />
                <FieldError>{validation.description}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-body">Markdown body</FieldLabel>
                <Textarea
                  className="min-h-56 resize-y font-mono text-xs leading-relaxed"
                  id="skill-body"
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, body: event.target.value } : current
                    )
                  }
                  value={draft.body}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Allow automatic invocation</FieldTitle>
                  <FieldDescription>
                    The model may choose this skill when it is relevant.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  aria-label="Allow automatic invocation"
                  checked={draft.allowModelInvocation}
                  onCheckedChange={(allowModelInvocation) =>
                    setDraft((current) =>
                      current ? { ...current, allowModelInvocation } : current
                    )
                  }
                />
              </Field>
              {mutationError ? <InlineError>{mutationError}</InlineError> : null}
            </FieldGroup>
          ) : null}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setDraft(undefined)} variant="outline">
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void saveDraft()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(open) => !open && setDeleteCandidate(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteCandidate?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The managed skill will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void deleteSkill()
              }}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsDetail>
  )
}
