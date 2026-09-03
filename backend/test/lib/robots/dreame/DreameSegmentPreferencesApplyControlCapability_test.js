const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameSegmentPreferencesApplyControlCapability = require("../../../../lib/robots/dreame/capabilities/DreameSegmentPreferencesApplyControlCapability");

const makeCapability = (readValue = 0, writeError = undefined) => {
    const calls = [];
    const robot = {
        miotHelper: {
            readProperty: async (siid, piid) => {
                calls.push({type: "read", siid: siid, piid: piid});
                return readValue;
            },
            writeProperty: async (siid, piid, value) => {
                calls.push({type: "write", siid: siid, piid: piid, value: value});

                if (writeError !== undefined) {
                    throw writeError;
                }
            }
        }
    };

    return {
        capability: new DreameSegmentPreferencesApplyControlCapability({
            robot: robot,
            siid: 4,
            piid: 26
        }),
        calls: calls
    };
};

describe("DreameSegmentPreferencesApplyControlCapability", function() {
    it("should read whether segment preferences are applied to full cleanups", async function() {
        const {capability, calls} = makeCapability(1);

        assert.equal(await capability.isEnabled(), true);
        assert.deepEqual(calls, [
            {type: "read", siid: 4, piid: 26}
        ]);
    });

    it("should enable segment preferences without writing the selected map's segment order", async function() {
        const {capability, calls} = makeCapability();

        await capability.enable();

        assert.deepEqual(calls, [
            {type: "write", siid: 4, piid: 26, value: 1}
        ]);
    });

    it("should propagate errors when enabling segment preferences fails", async function() {
        const writeError = new Error("MIOT write failed");
        const {capability} = makeCapability(0, writeError);

        await assert.rejects(capability.enable(), writeError);
    });

    it("should disable applying segment preferences to full cleanups", async function() {
        const {capability, calls} = makeCapability();

        await capability.disable();

        assert.deepEqual(calls, [
            {type: "write", siid: 4, piid: 26, value: 0}
        ]);
    });
});
