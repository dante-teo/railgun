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
custom drawing or custom chrome. Preserve system typography, control sizing,
focus behavior, menu integration, accessibility semantics, animations,
materials, and platform spacing unless an approved decision record establishes
an unmet requirement.

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

## Approved AppKit bridge register

AppKit bridges are narrow adapters around behavior unavailable through the
macOS 15 SwiftUI APIs. They must preserve native keyboard, focus, selection,
and accessibility behavior.

| Bridge | Approved scope | Required contract |
| --- | --- | --- |
| Advanced composer (`NSTextView`) | Dynamic sizing; paste; text selection; focus; submit versus newline handling; VoiceOver behavior. | Encapsulate the text view behind a SwiftUI-facing API and retain native editing, focus, selection, keyboard, and VoiceOver semantics. |
| Quick Look | Native preview behavior for validated local files. | Use only validated local URLs and retain the platform preview interaction. |
| Precise window coordination | Window behavior that supported SwiftUI presentation or scene APIs cannot provide. | Minimize the AppKit surface and preserve standard window, focus, and keyboard behavior. |
| Transcript system-scroller suppressor | Hide the enclosing `NSScrollView`'s vertical system scroller after SwiftUI indicator-hiding APIs have been applied. | Change only scroller visibility; retain SwiftUI scrolling, keyboard input, selection, focus, VoiceOver semantics, and scroll geometry. |

Future bridges require a decision record with documented proof that macOS 15
SwiftUI cannot meet the requirement. They are not approved merely for visual
control, convenience, or parity with a non-native implementation.

### Transcript system-scroller suppressor

- **Unmet requirement:** The Task transcript must use the compact left dash
  rail without also showing a visually conflicting system scrollbar.
- **Native APIs evaluated:** The transcript applies both
  `ScrollView(.vertical, showsIndicators: false)` and
  `.scrollIndicators(.hidden)`. The vertical `NSScroller` remained visible in
  the built app, so those APIs did not satisfy the requirement.
- **Deployment-target limitation:** macOS 15 SwiftUI does not expose the
  enclosing `NSScrollView` or a stronger system-scroller visibility contract.
  The adapter therefore locates only that enclosing scroll view and disables
  its vertical scroller.
- **Accessibility and interaction contract:** The adapter does not replace the
  `ScrollView`, scrolling physics, keyboard navigation, focus, selectable
  transcript text, VoiceOver structure, or `ScrollGeometry`. The dash rail is
  decorative and accessibility-hidden; **Jump to Latest** remains a native
  button.
- **Supported variants:** The adapter has no visual variants. The SwiftUI dash
  rail appears only for overflowing content, uses semantic foreground styles,
  tracks position with four active dashes, and caps the rail at 24 dashes.
- **Shared ownership:** This is feature-local to the Task transcript because it
  enforces that viewport's specific replacement-indicator contract. It is not
  a reusable control and does not belong in `RailgunUI` or its custom-component
  registry.
- **Retirement trigger:** Remove the adapter and AppKit import when supported
  SwiftUI indicator-hiding APIs reliably suppress the vertical system scroller
  across RailgunX's deployment targets, or if the product returns to the native
  scroller. Keep the SwiftUI transcript and its tests unchanged during that
  migration.

## Shared-component governance

Reusable custom UI belongs in `RailgunUI`. Feature targets must not create
independent versions of a shared control or presentation. Components expose
explicit enums and configuration values for their supported variants; do not
encode variants through feature-local modifier stacks or combinations of
booleans.

`RailgunCustomComponentRegistry.components` is the typed source of truth for
these reusable custom components. It starts empty deliberately: native SwiftUI
compositions in a feature do not need a registry entry, and no shared custom
control should be added until it has completed the workflow below. Contract and
registry declarations belong only in `Sources/RailgunUI`; the automated source
audit enforces that ownership without restricting ordinary feature-local
SwiftUI composition.

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
