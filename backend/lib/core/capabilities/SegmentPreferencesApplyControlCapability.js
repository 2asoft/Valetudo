const SimpleToggleCapability = require("./SimpleToggleCapability");

/**
 * Controls whether stored per-segment cleaning preferences are applied to normal full-clean starts.
 *
 * @template {import("../ValetudoRobot")} T
 * @extends SimpleToggleCapability<T>
 */
class SegmentPreferencesApplyControlCapability extends SimpleToggleCapability {
    getType() {
        return SegmentPreferencesApplyControlCapability.TYPE;
    }
}

SegmentPreferencesApplyControlCapability.TYPE = "SegmentPreferencesApplyControlCapability";

module.exports = SegmentPreferencesApplyControlCapability;
