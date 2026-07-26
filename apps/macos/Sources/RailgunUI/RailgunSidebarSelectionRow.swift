import SwiftUI

/// A compact sidebar row that uses Railgun's shared selected-state treatment.
public struct RailgunSidebarSelectionRow: View {
    private let title: String
    private let systemImage: String
    private let isSelected: Bool
    private let action: () -> Void

    public init(
        _ title: String,
        systemImage: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: RailgunSpacing.standard.points) {
                Label(title, systemImage: systemImage)
                Spacer(minLength: 0)
            }
            .font(RailgunFont.interface(.body, weight: .medium))
            .foregroundStyle(
                isSelected ? RailgunColorRole.accent.color : RailgunColorRole.primaryText.color
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, RailgunSpacing.standard.points)
            .padding(.vertical, RailgunSpacing.relaxed.points)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .background(
            isSelected ? Color.primary.opacity(0.08) : .clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityValue(isSelected ? "Selected" : "")
    }
}
