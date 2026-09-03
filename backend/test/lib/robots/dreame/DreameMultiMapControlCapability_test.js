const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameMultiMapControlCapability = require("../../../../lib/robots/dreame/capabilities/DreameMultiMapControlCapability");
const entities = require("../../../../lib/entities");
const RobotFirmwareError = require("../../../../lib/core/RobotFirmwareError");


const makeCapability = (resultCode = 0, status = entities.state.attributes.StatusStateAttribute.VALUE.DOCKED) => {
    const calls = {
        payloads: [],
        pollMap: 0
    };
    const robot = {
        dreameMapState: {
            selectedMapId: 68,
            knownMapIds: [62, 64, 66, 68],
            mapInfoById: {
                62: {name: "Map 1", rotation: 0},
                64: {name: "Map 2", rotation: 90},
                66: {name: "Map 3", rotation: 180},
                68: {name: "Map 4", rotation: 270}
            },
            mapPreviewDataById: {
                64: {map: "preview"}
            }
        },
        state: {
            map: undefined,
            getFirstMatchingAttribute: () => {
                return {
                    value: status
                };
            }
        },
        miotServices: {
            MAP: {
                SIID: 6,
                ACTIONS: {
                    EDIT: {
                        AIID: 2
                    }
                },
                PROPERTIES: {
                    MAP_DETAILS: {
                        PIID: 4
                    },
                    ACTION_RESULT: {
                        PIID: 6
                    }
                }
            }
        },
        sendDreameMapEditAction: async (payload, miotActions, miotProperties, options) => {
            calls.payloads.push({
                payload: payload,
                miotActions: miotActions,
                miotProperties: miotProperties,
                options: options
            });
            return resultCode;
        },
        pollMap: () => {
            calls.pollMap++;
        },
        getDreameSavedMapPreview: async mapId => {
            return {id: mapId};
        },
        getCurrentDreameSavedMapId: () => 66,
        applyDreameMapRotation: map => map,
        emitMapUpdated: () => undefined
    };

    return {
        capability: new DreameMultiMapControlCapability({
            robot: robot,
            miot_actions: {
                map_edit: {
                    siid: 6,
                    aiid: 2
                }
            },
            miot_properties: {
                mapDetails: {
                    piid: 4
                },
                actionResult: {
                    piid: 6
                }
            }
        }),
        calls: calls,
        robot: robot
    };
};

describe("DreameMultiMapControlCapability", function() {
    it("should expose known maps and selected map", async function() {
        const {capability} = makeCapability();

        assert.deepEqual((await capability.getState()), {
            selectedMapId: "68",
            maps: [
                {id: "62", name: "Map 1", selected: false, current: false, rotation: 0},
                {id: "64", name: "Map 2", selected: false, current: false, rotation: 90},
                {id: "66", name: "Map 3", selected: false, current: true, rotation: 180},
                {id: "68", name: "Map 4", selected: true, current: false, rotation: 270}
            ]
        });
    });

    it("should get a preview for a known map", async function() {
        const {capability} = makeCapability();

        assert.deepEqual((await capability.getMapPreview("64")), {id: 64});
    });

    it("should select a known map", async function() {
        const {capability, calls, robot} = makeCapability();

        await capability.selectMap("64");

        assert.equal(robot.dreameMapState.selectedMapId, 64);
        assert.equal(calls.pollMap, 1);
        assert.deepEqual(calls.payloads[0].payload, {sm: {}, mapid: 64});
        assert.deepEqual(calls.payloads[0].miotActions, {map_edit: {siid: 6, aiid: 2}});
        assert.deepEqual(calls.payloads[0].miotProperties, {
            mapDetails: {piid: 4},
            actionResult: {piid: 6}
        });
        assert.deepEqual(calls.payloads[0].options, {timeout: 5000});
    });

    it("should reject unknown maps", async function() {
        const {capability} = makeCapability();

        try {
            await capability.selectMap("99");
            throw new Error("Expected selectMap to throw");
        } catch (e) {
            assert.equal(e.message, "Unknown map '99'.");
        }
    });

    it("should throw firmware errors for failed select", async function() {
        const {capability} = makeCapability(7);

        try {
            await capability.selectMap("64");
            throw new Error("Expected selectMap to throw");
        } catch (e) {
            assert.ok(e instanceof RobotFirmwareError);
        }
    });

    it("should rename maps", async function() {
        const {capability, calls, robot} = makeCapability();

        await capability.renameMap("64", " Upstairs ");

        assert.deepEqual(calls.payloads[0].payload, {nrism: {64: {name: "Upstairs"}}});
        assert.equal(robot.dreameMapState.mapInfoById[64].name, "Upstairs");
    });

    it("should clear map names when renaming to whitespace", async function() {
        const {capability, calls, robot} = makeCapability();

        await capability.renameMap("64", " ");

        assert.deepEqual(calls.payloads[0].payload, {nrism: {64: {name: ""}}});
        assert.equal(robot.dreameMapState.mapInfoById[64].name, "");
    });

    it("should delete non-selected maps", async function() {
        const {capability, calls, robot} = makeCapability();

        await capability.deleteMap("64");

        assert.deepEqual(calls.payloads[0].payload, {cm: {}, mapid: 64});
        assert.deepEqual(robot.dreameMapState.knownMapIds, [62, 66, 68]);
        assert.equal(robot.dreameMapState.mapInfoById[64], undefined);
        assert.equal(robot.dreameMapState.mapPreviewDataById[64], undefined);
    });

    it("should reject deleting selected or current maps", async function() {
        const {capability} = makeCapability();

        await assert.rejects(
            capability.deleteMap("68"),
            {message: "Cannot delete the selected or currently loaded map."}
        );
        await assert.rejects(
            capability.deleteMap("66"),
            {message: "Cannot delete the selected or currently loaded map."}
        );
    });

    it("should rotate maps", async function() {
        const {capability, calls, robot} = makeCapability();

        await capability.rotateMap("64", 180);

        assert.deepEqual(calls.payloads[0].payload, {smra: {64: {ra: 180}}});
        assert.equal(robot.dreameMapState.mapInfoById[64].rotation, 180);
    });

    it("should reject invalid map rotations", async function() {
        const {capability} = makeCapability();

        try {
            await capability.rotateMap("64", 45);
            throw new Error("Expected rotateMap to throw");
        } catch (e) {
            assert.equal(e.message, "Invalid map rotation.");
        }
    });

    it("should reject map management while the robot is active", async function() {
        const {capability} = makeCapability(0, entities.state.attributes.StatusStateAttribute.VALUE.CLEANING);

        try {
            await capability.renameMap("64", "Upstairs");
            throw new Error("Expected renameMap to throw");
        } catch (e) {
            assert.equal(e.message, "Cannot edit saved maps while the robot is active.");
        }
    });
});
