const capabilities = require("../../../core/capabilities");

class MockMapSegmentEditCapability extends capabilities.MapSegmentEditCapability {
    async joinSegments() {
        // Mock-only no-op for UI prototyping.
    }

    async splitSegment() {
        // Mock-only no-op for UI prototyping.
    }
}

module.exports = MockMapSegmentEditCapability;
