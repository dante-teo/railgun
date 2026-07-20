# Native-first UI policy

This policy governs native macOS UI in RailgunX. It turns the Swift
implementation plan's native-first contract into a decision record and bridge
inventory that feature work must follow.

## Default: native SwiftUI

Native SwiftUI is the default. Begin with the system components and styling
appropriate to the feature, including `NavigationSplitView`, `List`, `Table`,
`Form`, `Section`, `Toolbar`, `Button`, `TextField`, `TextEditor`,
`SecureField`, `Toggle`, `Picker`, `Menu`, `DisclosureGroup`, `ProgressView`,
`ContentUnavailableView`, `Settings`, sheets, alerts, confirmation dialogs,
and inspectors.

Do not recreate system controls, menus, dialogs, sidebars, toolbars, forms,
materials, focus rings, keyboard navigation, or accessibility behavior with
custom drawing or custom chrome. Preserve system text scaling, control sizing,
focus behavior, menu integration, accessibility semantics, animations,
materials, and platform spacing unless an approved decision record establishes
an unmet requirement. Railgun's approved application typography is Barlow for
interface text and Departure Mono Nerd Font for code; it continues to use
SwiftUI text styles for Dynamic Type scaling.

## Customization decision record

Before adding a custom component or an AppKit bridge, add a completed record to
the feature's design or implementation documentation. Use this template:

```md
### [Component or bridge name]

- **Unmet requirement:** What product or interaction need cannot be met as-is?
- **Native APIs evaluated:** Which deployment-target SwiftUI APIs were tried or
  assessed, and why is each insufficient?
- **Deployment-target limitation:** What specifically prevents macOS 15
  SwiftUI from satisfying the requirement?
- **Accessibility and interaction contract:** Document keyboard navigation,
  shortcuts, focus, selection, VoiceOver semantics and accessible names,
  control states, and reduced-motion behavior.
- **Supported variants:** List all applicable content, emphasis, size,
  semantic role, selection, loading, destructive, compact, and material
  variants.
- **Shared ownership:** State whether it belongs in `RailgunUI`; if not,
  explain why it cannot be reused outside the feature.
- **Retirement trigger:** Name the native API, deployment target, or product
  simplification that would allow the customization to be removed, and the
  migration plan.
```

The record is proof that customization is necessary, not a request for a
different visual treatment. A new decision record is required when a component
or bridge gains a material new behavior or variant.

### `RailgunMarkdownMessage`

- **Unmet requirement:** Completed assistant history requires safe
  CommonMark/GFM rendering with selectable rich text, wrapped code, table
  scrolling, and accessible image states.
- **Native APIs evaluated:** macOS 15 SwiftUI has no Markdown view that
  combines destination filtering, text selection, native table scrolling, and
  image loading/failure semantics.
- **Accessibility and interaction contract:** Links keep native external-link
  behavior; code and tables are selectable; images announce their alt text and
  loading, failure, or invalid-source state to VoiceOver.
- **Shared ownership:** The renderer is a registered `RailgunUI` component for
  completed Markdown surfaces. User and incomplete assistant messages remain
  ordinary selectable `Text` views.
- **Retirement trigger:** Replace it when SwiftUI provides a safe native
  Markdown renderer with equivalent selection, image, code, and table support.

### `RailgunComposer`

- **Requirement:** The Task composer provides native multiline paste,
  selection, undo, text services, first-responder control, bounded growth, and
  distinct Return, Shift-Return, and active-run Tab behavior in one reusable
  control.
- **Native APIs evaluated:** `TextEditor` supplies basic multiline entry, but
  macOS 15 SwiftUI does not expose the required text-system sizing, responder,
  selection-preserving synchronization, or Return-command interception contract
  as one control.
- **Deployment-target limitation:** On macOS 15, SwiftUI cannot combine a
  bounded visual height with a full scrollable text document while preserving
  native command routing and explicit first-responder synchronization.
- **Accessibility and interaction contract:** SwiftUI owns the draft, focus,
  enabled state, and reported height. The bridge preserves native editing,
  selection, multiline paste, undo, and text services; its accessible name `Message`
  retains native VoiceOver editing semantics. Return submits a nonblank
  enabled draft, Shift-Return remains a native line break, active-run Tab
  queues a nonblank follow-up, and a disabled composer consumes those commands
  without submitting.
- **Sizing and scrolling contract:** The control reports a height from one
  through ten visual lines. Above ten lines, its viewport remains capped while
  the `NSTextView` document retains its full height and vertical scrolling is
  enabled.
- **Shared ownership and rollout:** `RailgunComposer` is a registered
  `RailgunUI` component. SWFT-032 mounts it in `RailgunTaskShell`; the shell,
  not the bridge, owns draft clearing and prompt, steering, and follow-up RPC
  workflows. The shell keeps the editor inside Railgun's shared chat surface:
  a centered 736-point content column, bordered material card, idle send
  affordance, queue/error presentation, and attached keyboard hint. AppKit
  remains limited to the text editor and command interception.
- **Retirement trigger:** Replace it when SwiftUI provides a native multiline
  editor with equivalent sizing, scrolling, command routing, focus, selection,
  paste, undo, text-services, and VoiceOver behavior.

## Approved AppKit bridge register

AppKit bridges are narrow adapters around behavior unavailable through the
macOS 15 SwiftUI APIs. They must preserve native keyboard, focus, selection,
and accessibility behavior.

| Bridge | Approved scope | Required contract |
| --- | --- | --- |
| Advanced composer (`NSTextView`) | One-through-ten-line sizing; overflow scrolling; paste; text selection; focus; submit versus newline handling; VoiceOver behavior. | Encapsulate the text view behind a SwiftUI-facing API; keep the full document taller than the capped viewport on overflow, and retain native editing, focus, selection, keyboard, and VoiceOver semantics. |
| Quick Look | Native preview behavior for validated local files. | Use only validated local URLs and retain the platform preview interaction. |
| Precise window coordination | Window behavior that supported SwiftUI presentation or scene APIs cannot provide. | Minimize the AppKit surface and preserve standard window, focus, and keyboard behavior. |

Future bridges require a decision record with documented proof that macOS 15
SwiftUI cannot meet the requirement. They are not approved merely for visual
control, convenience, or parity with a non-native implementation.

## Native composer bridge invariant

`RailgunComposer` is a `RailgunUI` bridge, not a submission workflow. The
SwiftUI caller is the sole owner of its draft, focus, enabled state, and
reported height; AppKit owns only native text-system behavior. SWFT-032 mounts
it in `RailgunTaskShell`: idle Return starts a prompt, active Return queues
steering, and active Tab queues a follow-up. The shell clears queued drafts
after their corresponding acknowledgements and keeps queue failures editable
for a same-kind retry. Initial prompt responses settle when their
agent run completes, so their acknowledgement is observed asynchronously and
must not keep the composer disabled. Keep these invariants intact:

- Grow from one through ten visual lines and report the clamped viewport
  height. When content exceeds that cap, keep the `NSTextView` document at its
  complete content height so its native vertical scroller can reveal every
  line.
- Intercept Return only for a nonblank editable draft. When SwiftUI supplies
  the optional enqueue callback, intercept nonblank editable Tab for a
  follow-up. Blank Tab, inactive Tab, Shift-Return, and every other native
  editing command retain AppKit behavior. A disabled composer must never
  submit or enqueue a draft.
- Preserve selection when an external draft change is applied, and synchronize
  first-responder changes back to the focus binding.
- Keep prompt, steering, and follow-up RPC effects outside the bridge. The
  shell renders FIFO pending acknowledgements until backend queue updates
  insert their user messages.

Focused coverage lives in `RailgunComposerTests`, which verifies sizing and
overflow, Return, Tab, and Shift-Return behavior, disabled callback
suppression, multiline paste and selection preservation, accessibility
configuration, SwiftUI state synchronization, and first-responder handoff.

## Transcript soft top-edge invariant

On macOS 26 and later, the Task transcript applies
`.scrollEdgeEffectStyle(.soft, for: .top)`. The effect depends on the native
`ScrollView` and its vertical scroller participating in the initial view
layout. Treat the following as implementation invariants:

- Keep the same root transcript `ScrollView` mounted for loading, empty,
  selection-required, selected, and stale-selection states. Present
  non-scrollable state content as an overlay outside the scroll content.
- A mounted scroll view does not imply mounted message rows. Populate its
  `LazyVStack` only for a valid selected task so retained messages are not
  visible, scrollable, selectable, or accessibility-exposed behind loading or
  content-unavailable overlays.
- Keep the native vertical scroll indicator enabled. Do not pass
  `showsIndicators: false`, apply `.scrollIndicators(.hidden)`, introspect the
  enclosing `NSScrollView`, set `hasVerticalScroller` to `false`, hide its
  `verticalScroller`, or add a replacement scrollbar.
- Do not disable the root scroll view while it is empty or loading. Disabling
  it during initial layout can prevent the edge effect from initializing.
- Keep non-scrolling UI, including the docked Activity pane and empty-state
  overlays, outside the `ScrollView` content hierarchy.
- Present refresh, create, resume, and archive failures in the non-scrolling
  `session-operation-error` overlay banner. Do not make error visibility depend
  on transcript content or selection state.

Resizing the window can cause a broken implementation to begin rendering the
effect, so resize-based checks are not valid verification. Verify from a cold
launch without resizing:

1. Use a short window height and a transcript long enough to overflow.
2. Scroll transcript text beneath the top edge and confirm the soft blur is
   visible immediately.
3. Repeat with Activity hidden, docked, and floating.
4. Confirm loading and content-unavailable presentations remain centered and
   do not scroll, and that a previous task's retained rows are neither visible
   nor exposed to accessibility.
5. Trigger a session-operation failure and confirm its banner remains visible
   in selected and non-selected states.

The focused source-contract test in `RailgunXAppTests` protects the native
scroller requirements. `RailgunAppStoreTests` protects the selected-only
message and operation-error presentation rules. The visual blur itself still
requires the manual check above because XCTest cannot reliably assert
compositor output.

## Activity panel layout invariant

Activity is a non-scrolling companion to the transcript. Its presentation must
not feed back into transcript scroll geometry:

- Base the docked-versus-floating decision on a stable detail viewport
  measurement outside the transcript `ScrollView`. Do not derive it from
  `onScrollGeometryChange` or a scroll-content width: changing the docked
  content margin can otherwise repeatedly change the measured width and hang or
  crash while toggling Activity.
- At 900pt or more of detail width, overlay the glass panel at the leading edge
  and reserve 376pt of transcript content width. Below that threshold, present
  the 320×360 panel as a toolbar-anchored popover and reserve no transcript
  width.
- Keep the Activity panel outside transcript scroll content. Its dashboard
  `ScrollView` must apply `.scrollContentBackground(.hidden)` so it does not
  paint over the glass material.
- The sidebar-toolbar Activity toggle is the sole visibility control. The
  panel has no independent close button.

The focused source-contract tests protect the stable detail viewport measurement,
presentation threshold, transparent dashboard scroll content, and sole-toggle
visibility contract. Visual verification still requires testing both compact
and wide window widths in light and dark appearance.

## Shared-component governance

Reusable custom UI belongs in `RailgunUI`. Feature targets must not create
independent versions of a shared control or presentation. Components expose
explicit enums and configuration values for their supported variants; do not
encode variants through feature-local modifier stacks or combinations of
booleans.

`RailgunCustomComponentRegistry.components` is the typed source of truth for
these reusable custom components. Native SwiftUI compositions in a feature do
not need a registry entry; shared controls are added only after completing the
workflow below. Contract and registry declarations belong only in
`Sources/RailgunUI`; the automated source audit enforces that ownership without
restricting ordinary feature-local SwiftUI composition.

Before introducing a reusable custom component:

1. Complete the customization decision record above in the feature
   documentation.
2. Add a `RailgunCustomComponentSpecification` in `RailgunUI`, including its
   stable ID, `RailgunUI` source path, supported variants and states,
   customization rationale, macOS 15 native-API limitation, retirement
   trigger, preview matrix, and accessibility contract.
3. Register the specification in `RailgunCustomComponentRegistry.components`.
4. Use `RailgunCustomComponentPreviewMatrixView` in the component's `#Preview`
   declarations so every declared variant, state, appearance, accessibility
   condition, and relevant width renders consistently. Declare every variant,
   state, preview condition, and width exactly once; duplicate axes create
   duplicate preview identities and are rejected by the validator.
5. Add focused contract tests for the component before relying on it from a
   feature.

Use the existing `RailgunUI` semantic design roles for colors, typography,
spacing, materials, focus, and motion. These roles support native appearance;
they do not authorize replacement control styling. Feature code supplies
content and state, not component-local colors or arbitrary geometry.

## Component validation and retirement

Every custom component must include documented previews for every supported
variant, light and dark appearance, increased contrast, reduced transparency,
reduced motion, long content, error, loading, disabled states, and relevant
window widths. `RailgunCustomComponentValidator` checks this declaration
deterministically in XCTest, including duplicate variants, states, preview
conditions, and widths. Interactive components must also have focused coverage
of keyboard behavior, focus, VoiceOver, accessible names, state changes, and
reduced motion.

When a supported native API becomes sufficient, migrate to it and remove the
custom component or AppKit bridge. Update the decision record to show that the
retirement trigger was met and that the replacement preserves the documented
contract.
