const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const MiioValetudoRobot = require("../../../lib/robots/MiioValetudoRobot");


describe("MiioValetudoRobot", function() {
    it("should retain uploaded FDS data by generated object name for fresh firmware references", function() {
        const robot = Object.create(MiioValetudoRobot.prototype);
        const data = Buffer.from("firmware-map-object");

        robot.storeUploadedFDSData(data, {objectName: "fresh-map-object"});

        assert.equal(robot.getUploadedFDSData("fresh-map-object"), data);
        assert.equal(robot.getUploadedFDSData("missing-object"), undefined);
    });

    it("should ignore FDS uploads without generated object names", function() {
        const robot = Object.create(MiioValetudoRobot.prototype);

        robot.storeUploadedFDSData(Buffer.from("ignored"), {});

        assert.equal(robot.uploadedFDSObjectsByName, undefined);
    });

    it("should evict old FDS objects from the embedded-memory cache", function() {
        const robot = Object.create(MiioValetudoRobot.prototype);

        for (let i = 0; i <= MiioValetudoRobot.MAX_STORED_FDS_OBJECTS; i++) {
            robot.storeUploadedFDSData(Buffer.from(`object-${i}`), {objectName: `object-${i}`});
        }

        assert.equal(robot.uploadedFDSObjectsByName.size, MiioValetudoRobot.MAX_STORED_FDS_OBJECTS);
        assert.equal(robot.getUploadedFDSData("object-0"), undefined);
        assert.deepEqual(
            robot.getUploadedFDSData(`object-${MiioValetudoRobot.MAX_STORED_FDS_OBJECTS}`),
            Buffer.from(`object-${MiioValetudoRobot.MAX_STORED_FDS_OBJECTS}`)
        );
    });
});
