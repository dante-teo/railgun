import RailgunTransport
import RailgunUI
import SwiftUI

struct RailgunAuthenticationSettings: View {
    let state: RailgunAuthenticationState
    let backendPhase: RailgunBackendPhase
    let login: () -> Void
    let logout: () -> Void

    var body: some View {
        Section {
            LabeledContent("Status") {
                Label(statusTitle, systemImage: statusSystemImage)
                    .foregroundStyle(statusColor)
            }

            Text(statusMessage)
                .font(RailgunFont.interface(.caption))
                .foregroundStyle(RailgunColorRole.secondaryText.color)

            actionContent
        } header: {
            Text("Devin")
        } footer: {
            Text("Railgun stores the Devin access token in its local credential store.")
        }
    }

    @ViewBuilder
    private var actionContent: some View {
        switch state.phase {
        case .authenticated(source: .environment), .signedOut(source: .environment):
            EmptyView()
        case .authenticated:
            HStack {
                Button("Log in again", systemImage: "arrow.clockwise", action: login)
                    .accessibilityIdentifier("settings-devin-relogin")
                Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: logout)
                    .accessibilityIdentifier("settings-devin-logout")
            }
        case .signedOut(source: .file):
            Button("Log in", systemImage: "person.crop.circle.badge.checkmark", action: login)
                .accessibilityIdentifier("settings-devin-login")
        case .loggingIn:
            ProgressView("Finish signing in with Devin…")
                .controlSize(.small)
        case .loggingOut:
            ProgressView("Signing out…")
                .controlSize(.small)
        case .checking, .unavailable:
            EmptyView()
        case .failed:
            if isBackendReady {
                HStack {
                    Button("Log in again", systemImage: "arrow.clockwise", action: login)
                        .accessibilityIdentifier("settings-devin-relogin")
                    Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: logout)
                        .accessibilityIdentifier("settings-devin-logout")
                }
            } else {
                Button("Log in", systemImage: "person.crop.circle.badge.checkmark", action: login)
                    .accessibilityIdentifier("settings-devin-login")
            }
        }
    }

    private var isBackendReady: Bool {
        if case .ready = backendPhase { return true }
        return false
    }

    private var statusTitle: String {
        switch state.phase {
        case .checking: "Checking…"
        case let .authenticated(source):
            source == .environment ? "Connected via DEVIN_TOKEN" : "Connected"
        case .signedOut: "Not signed in"
        case .loggingIn: "Waiting for Devin sign-in"
        case .loggingOut: "Signing out"
        case .failed: "Sign-in needs attention"
        case .unavailable: "Unavailable in this build"
        }
    }

    private var statusMessage: String {
        switch state.phase {
        case .checking:
            "Checking your Devin credentials."
        case .authenticated(source: .environment):
            "Devin is managed by DEVIN_TOKEN in the environment that launched Railgun."
        case .authenticated:
            "Devin is connected. Log in again to switch accounts."
        case .signedOut(source: .environment):
            "Remove DEVIN_TOKEN from the launch environment to use Railgun sign-in."
        case .signedOut:
            "Railgun will open Devin in your default browser so you can sign in."
        case .loggingIn:
            "Complete the Devin sign-in in the browser window opened by Railgun."
        case .loggingOut:
            "Removing the cached Devin credential and reconnecting Railgun."
        case let .failed(message):
            message
        case .unavailable:
            "Devin sign-in is unavailable in this backend mode."
        }
    }

    private var statusSystemImage: String {
        switch state.phase {
        case .authenticated: "checkmark.circle.fill"
        case .signedOut: "person.crop.circle.badge.xmark"
        case .loggingIn, .loggingOut, .checking: "clock"
        case .failed: "exclamationmark.triangle.fill"
        case .unavailable: "minus.circle"
        }
    }

    private var statusColor: Color {
        switch state.phase {
        case .authenticated: .green
        case .signedOut: .orange
        case .failed: .red
        default: .secondary
        }
    }
}
