import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'

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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { MemoryCategory, MemoryRecord } from '@/lib/personalization-api'

interface MemoryDraft {
  category: MemoryCategory
  content: string
  memory?: MemoryRecord
}

const memoryCategories: readonly { id: MemoryCategory; label: string }[] = [
  { id: 'preference', label: 'Preference' },
  { id: 'fact', label: 'Fact' },
  { id: 'project', label: 'Project' }
]

function categoryLabel(category: MemoryCategory): string {
  return memoryCategories.find(({ id }) => id === category)?.label ?? category
}

function memoryMatchesQuery(memory: MemoryRecord, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  return (
    !normalizedQuery ||
    `${memory.content} ${categoryLabel(memory.category)}`.toLowerCase().includes(normalizedQuery)
  )
}

export function PersonalizationSettings({
  registerSaveBeforeNavigation
}: {
  registerSaveBeforeNavigation: (save?: () => Promise<boolean>) => void
}): React.JSX.Element {
  const [soulOriginal, setSoulOriginal] = useState('')
  const [soulDraft, setSoulDraft] = useState('')
  const [soulState, setSoulState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>(
    'loading'
  )
  const [soulError, setSoulError] = useState<string>()
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([])
  const [memoryLoading, setMemoryLoading] = useState(true)
  const [memoryLoadError, setMemoryLoadError] = useState<string>()
  const [memoryMutationError, setMemoryMutationError] = useState<string>()
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>()
  const [memoryValidation, setMemoryValidation] = useState<string>()
  const [deleteCandidate, setDeleteCandidate] = useState<MemoryRecord>()
  const [enteringMemoryId, setEnteringMemoryId] = useState<string>()
  const [exitingMemoryIds, setExitingMemoryIds] = useState<ReadonlySet<string>>(new Set())
  const [memoryMotionRevision, setMemoryMotionRevision] = useState(0)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const memoryRequest = useRef(0)

  const requestSoul = useCallback((): void => {
    void window.railgun.personalization.soul.get().then(
      (content) => {
        setSoulOriginal(content)
        setSoulDraft(content)
        setSoulState('idle')
      },
      () => {
        setSoulError('Could not load SOUL.md.')
        setSoulState('error')
      }
    )
  }, [])

  useEffect(requestSoul, [requestSoul])

  const loadSoul = (): void => {
    setSoulState('loading')
    setSoulError(undefined)
    requestSoul()
  }

  const requestMemories = useCallback((searchQuery: string): void => {
    const request = ++memoryRequest.current
    void window.railgun.personalization.memories.list(searchQuery || undefined).then(
      (records) => {
        if (request === memoryRequest.current) {
          setMemories(records)
          setMemoryLoading(false)
        }
      },
      () => {
        if (request === memoryRequest.current) {
          setMemoryLoadError('Could not load memories.')
          setMemoryLoading(false)
        }
      }
    )
  }, [])

  useEffect(() => requestMemories(deferredQuery.trim()), [deferredQuery, requestMemories])

  const loadMemories = useCallback(
    (searchQuery: string): void => {
      setMemoryLoading(true)
      setMemoryLoadError(undefined)
      requestMemories(searchQuery)
    },
    [requestMemories]
  )

  const soulDirty = soulDraft !== soulOriginal
  const saveSoul = useCallback(async (): Promise<boolean> => {
    if (soulDraft === soulOriginal) return true
    setSoulState('saving')
    setSoulError(undefined)
    try {
      const saved = await window.railgun.personalization.soul.set(soulDraft)
      setSoulOriginal(saved)
      setSoulDraft(saved)
      setSoulState('saved')
      return true
    } catch {
      setSoulError('SOUL.md could not be saved. Your draft is still here.')
      setSoulState('error')
      return false
    }
  }, [soulDraft, soulOriginal])

  const saveMemory = useCallback(async (): Promise<boolean> => {
    if (!memoryDraft) return true
    const content = memoryDraft.content.trim()
    if (!content) {
      setMemoryValidation('Memory text is required.')
      return false
    }
    setMemoryBusy(true)
    setMemoryMutationError(undefined)
    setMemoryValidation(undefined)
    try {
      const input = { content, category: memoryDraft.category }
      const saved = memoryDraft.memory
        ? await window.railgun.personalization.memories.update(memoryDraft.memory.id, input)
        : await window.railgun.personalization.memories.create(input)
      const matchesQuery = memoryMatchesQuery(saved, deferredQuery)
      setMemories((current) =>
        memoryDraft.memory
          ? current.flatMap((memory) =>
              memory.id === saved.id ? (matchesQuery ? [saved] : []) : [memory]
            )
          : matchesQuery
            ? [saved, ...current.filter(({ id }) => id !== saved.id)]
            : current
      )
      if (!memoryDraft.memory && matchesQuery) setEnteringMemoryId(saved.id)
      setMemoryMotionRevision((current) => current + 1)
      setMemoryDraft(undefined)
      return true
    } catch {
      setMemoryMutationError('The memory could not be saved. Your draft is still here.')
      return false
    } finally {
      setMemoryBusy(false)
    }
  }, [deferredQuery, memoryDraft])

  useEffect(() => {
    registerSaveBeforeNavigation(async () => {
      const soulSaved = await saveSoul()
      if (!soulSaved) return false
      return saveMemory()
    })
    return () => registerSaveBeforeNavigation(undefined)
  }, [registerSaveBeforeNavigation, saveMemory, saveSoul])

  const deleteMemory = async (): Promise<void> => {
    if (!deleteCandidate || memoryBusy) return
    setMemoryBusy(true)
    setMemoryMutationError(undefined)
    try {
      await window.railgun.personalization.memories.delete(deleteCandidate.id)
      const deletedId = deleteCandidate.id
      setDeleteCandidate(undefined)
      setExitingMemoryIds((current) => new Set([...current, deletedId]))
    } catch {
      setMemoryMutationError('The memory could not be deleted. The list was not changed.')
    } finally {
      setMemoryBusy(false)
    }
  }

  const finishMemoryExit = (memoryId: string): void => {
    setMemories((current) => current.filter(({ id }) => id !== memoryId))
    setExitingMemoryIds(
      (current) => new Set([...current].filter((currentId) => currentId !== memoryId))
    )
    setMemoryMotionRevision((current) => current + 1)
  }

  const soulPresentationState =
    soulState === 'loading'
      ? 'loading'
      : soulState === 'error' && !soulOriginal && !soulDraft
        ? 'error'
        : 'ready'
  const soulStatusState = soulState === 'saving' || soulState === 'saved' ? soulState : 'resting'
  const memoryInteractionLocked = memoryBusy || exitingMemoryIds.size > 0

  return (
    <SettingsDetail
      description="Shape Railgun’s working style and maintain the facts it can recall."
      title="Personalization"
    >
      <SettingsSection
        action={
          <SettingsCrossfade layout="inline" stateKey={soulStatusState}>
            {soulState === 'saving' ? (
              <Badge variant="secondary">Saving</Badge>
            ) : soulState === 'saved' ? (
              <Badge variant="secondary">Saved</Badge>
            ) : soulDirty ? (
              <Badge variant="outline">Unsaved</Badge>
            ) : null}
          </SettingsCrossfade>
        }
        description="Railgun reads ~/.railgun/SOUL.md as personal guidance."
        title="SOUL.md"
      >
        <SettingsCrossfade stateKey={soulPresentationState}>
          {soulState === 'loading' ? (
            <SettingsLoading label="SOUL.md is loading" />
          ) : soulState === 'error' && !soulOriginal && !soulDraft ? (
            <div className="flex items-center justify-between gap-3">
              <InlineError animatePresence={false}>{soulError}</InlineError>
              <Button onClick={loadSoul} variant="outline">
                Retry
              </Button>
            </div>
          ) : (
            <FieldGroup>
              <Field data-invalid={Boolean(soulError)}>
                <FieldLabel htmlFor="soul-editor">Personal instructions</FieldLabel>
                <Textarea
                  aria-invalid={Boolean(soulError)}
                  className="min-h-48 resize-y font-mono text-xs leading-relaxed"
                  id="soul-editor"
                  onChange={(event) => {
                    setSoulDraft(event.target.value)
                    setSoulState('idle')
                    setSoulError(undefined)
                  }}
                  value={soulDraft}
                />
                <FieldError>{soulError}</FieldError>
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={!soulDirty || soulState === 'saving'}
                  onClick={() => {
                    setSoulDraft(soulOriginal)
                    setSoulError(undefined)
                    setSoulState('idle')
                  }}
                  variant="outline"
                >
                  Revert
                </Button>
                <Button
                  disabled={!soulDirty || soulState === 'saving'}
                  onClick={() => void saveSoul()}
                >
                  Save
                </Button>
              </div>
            </FieldGroup>
          )}
        </SettingsCrossfade>
      </SettingsSection>

      <SettingsSection
        action={
          <Button
            disabled={memoryInteractionLocked}
            onClick={() => setMemoryDraft({ content: '', category: 'preference' })}
            size="sm"
          >
            <Plus data-icon="inline-start" />
            New Memory
          </Button>
        }
        description="Search and manage up to 100 saved memories."
        title="Memories"
      >
        <FieldGroup>
          <Field>
            <FieldLabel className="sr-only" htmlFor="memory-search">
              Search memories
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-8"
                disabled={exitingMemoryIds.size > 0}
                id="memory-search"
                onChange={(event) => {
                  setMemoryLoading(true)
                  setMemoryLoadError(undefined)
                  setQuery(event.target.value)
                }}
                placeholder="Search memories"
                type="search"
                value={query}
              />
            </div>
          </Field>
        </FieldGroup>
        <InlineError>{memoryMutationError}</InlineError>
        {memoryLoading ? (
          <SettingsLoading label="Memories are loading" />
        ) : memoryLoadError ? (
          <div className="flex items-center justify-between gap-3">
            <InlineError>{memoryLoadError}</InlineError>
            <Button onClick={() => loadMemories(deferredQuery.trim())} variant="outline">
              Retry
            </Button>
          </div>
        ) : memories.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{query ? 'No matching memories' : 'No memories yet'}</EmptyTitle>
              <EmptyDescription>
                {query ? 'Try a different search.' : 'Save a preference, fact, or project note.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingsAnimatedList ariaLabel="Memories" motionRevision={memoryMotionRevision}>
            {memories.map((memory) => (
              <SettingsListItem
                entering={enteringMemoryId === memory.id}
                exiting={exitingMemoryIds.has(memory.id)}
                itemKey={memory.id}
                key={memory.id}
                onExitComplete={() => finishMemoryExit(memory.id)}
              >
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
                  <Badge className="mt-2" variant="outline">
                    {categoryLabel(memory.category)}
                  </Badge>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    aria-label={`Edit memory: ${memory.content}`}
                    disabled={memoryInteractionLocked}
                    onClick={() => setMemoryDraft({ ...memory, memory })}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    aria-label={`Delete memory: ${memory.content}`}
                    disabled={memoryInteractionLocked}
                    onClick={() => setDeleteCandidate(memory)}
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
      </SettingsSection>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !memoryBusy) {
            setMemoryDraft(undefined)
            setMemoryValidation(undefined)
            setMemoryMutationError(undefined)
          }
        }}
        open={Boolean(memoryDraft)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{memoryDraft?.memory ? 'Edit Memory' : 'New Memory'}</DialogTitle>
            <DialogDescription>Memories are available to future tasks.</DialogDescription>
          </DialogHeader>
          {memoryDraft ? (
            <FieldGroup>
              <Field data-invalid={Boolean(memoryValidation)}>
                <FieldLabel htmlFor="memory-content">Memory</FieldLabel>
                <Textarea
                  aria-invalid={Boolean(memoryValidation)}
                  id="memory-content"
                  onChange={(event) =>
                    setMemoryDraft((current) =>
                      current ? { ...current, content: event.target.value } : current
                    )
                  }
                  value={memoryDraft.content}
                />
                <FieldError>{memoryValidation}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="memory-category">Category</FieldLabel>
                <Select
                  onValueChange={(category) =>
                    setMemoryDraft((current) =>
                      current ? { ...current, category: category as MemoryCategory } : current
                    )
                  }
                  value={memoryDraft.category}
                >
                  <SelectTrigger id="memory-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {memoryCategories.map(({ id, label }) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>Choose Preference, Fact, or Project.</FieldDescription>
              </Field>
              <InlineError>{memoryMutationError}</InlineError>
            </FieldGroup>
          ) : null}
          <DialogFooter>
            <Button
              disabled={memoryBusy}
              onClick={() => setMemoryDraft(undefined)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={memoryBusy} onClick={() => void saveMemory()}>
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
            <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={memoryBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={memoryBusy}
              onClick={(event) => {
                event.preventDefault()
                void deleteMemory()
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
