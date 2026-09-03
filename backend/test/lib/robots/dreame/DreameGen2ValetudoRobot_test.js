const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameGen2ValetudoRobot = require("../../../../lib/robots/dreame/DreameGen2ValetudoRobot");


describe("DreameGen2ValetudoRobot", function() {
    it("should poll customized cleaning as a read-only preference source signal", function() {
        const robot = Object.create(DreameGen2ValetudoRobot.prototype);
        robot.highResolutionWaterGrades = false;

        const properties = robot.getStatePropertiesToPoll();

        assert.ok(properties.some(property => property.siid === 4 && property.piid === 26));
    });
});
