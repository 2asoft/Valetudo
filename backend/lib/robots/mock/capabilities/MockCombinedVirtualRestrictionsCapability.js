const capabilities = require("../../../core/capabilities");

class MockCombinedVirtualRestrictionsCapability extends capabilities.CombinedVirtualRestrictionsCapability {
    async setVirtualRestrictions() {
        // Mock-only no-op for UI prototyping.
    }
}

module.exports = MockCombinedVirtualRestrictionsCapability;
