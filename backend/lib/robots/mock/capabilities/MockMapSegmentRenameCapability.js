const capabilities = require("../../../core/capabilities");

class MockMapSegmentRenameCapability extends capabilities.MapSegmentRenameCapability {
    async renameSegment() {
        // Mock-only no-op for UI prototyping.
    }
}

module.exports = MockMapSegmentRenameCapability;
