import Foundation
import Testing

struct ChatSheetsSourceGuardTests {
    @Test func `session sheet renders individual action failures while open`() throws {
        let source = try String(contentsOf: Self.chatSheetsSourceURL(), encoding: .utf8)
        let inspector = try String(contentsOf: Self.inspectorSourceURL(), encoding: .utf8)

        #expect(source.contains("if let errorText = self.viewModel.errorText"))
        #expect(source.contains("Text(verbatim: errorText)"))
        #expect(source.contains(".foregroundStyle(OpenClawChatTheme.danger)"))
        #expect(source.contains("self.viewModel.errorText = nil"))
        #expect(inspector.contains("self.errorText ?? self.viewModel.errorText"))
        #expect(inspector.contains("Text(verbatim: errorText)"))
    }

    private static func chatSheetsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/OpenClawChatUI/ChatSheets.swift")
    }

    private static func inspectorSourceURL() -> URL {
        self.chatSheetsSourceURL()
            .deletingLastPathComponent()
            .appendingPathComponent("ChatSessionManagementViews.swift")
    }
}
