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

Future bridges require a decision record with documented proof that macOS 15
SwiftUI cannot meet the requirement. They are not approved merely for visual
control, convenience, or parity with a non-native implementation.

## Shared-component governance

Reusable custom UI belongs in `RailgunUI`. Feature targets must not create
independent versions of a shared control or presentation. Components expose
explicit enums and configuration values for their supported variants; do not
encode variants through feature-local modifier stacks or combinations of
booleans.

Use the existing `RailgunUI` semantic design roles for colors, typography,
spacing, materials, focus, and motion. These roles support native appearance;
they do not authorize replacement control styling. Feature code supplies
content and state, not component-local colors or arbitrary geometry.

## Component validation and retirement

Every custom component must include documented previews for every supported
variant, light and dark appearance, increased contrast, reduced transparency,
reduced motion, long content, error, loading, disabled states, and relevant
window widths. Interactive components must also have focused coverage of
keyboard behavior, focus, VoiceOver, accessible names, and state changes.

When a supported native API becomes sufficient, migrate to it and remove the
custom component or AppKit bridge. Update the decision record to show that the
retirement trigger was met and that the replacement preserves the documented
contract.
