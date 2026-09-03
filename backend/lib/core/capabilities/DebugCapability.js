const Capability = require("./Capability");
const crypto = require("crypto");
const entities = require("../../entities");

/**
 * @extends Capability<import("../ValetudoRobot")>
 */
class DebugCapability extends Capability {
    getType() {
        return DebugCapability.TYPE;
    }

    /**
     * @param {object} command
     * @returns {Promise<unknown>}
     */
    async execute(command) {
        switch (command?.action) {
            case "readProperty":
                return this.readProperty(command.siid, command.piid);
            case "writeProperty":
                this.assertInactive(command.force === true);
                return this.writeProperty(command.siid, command.piid, command.value);
            case "executeAction":
                this.assertInactive(command.force === true);
                return this.executeAction(command.siid, command.aiid, command.params ?? []);
            case "getCurrentMapSummary":
                return this.getCurrentMapSummary();
            case "getDreameMapState":
                return this.getDreameMapState();
            case "listUploadedFDSObjects":
                return this.listUploadedFDSObjects();
            case "getUploadedFDSObject":
                return this.getUploadedFDSObject(command.objectName);
            default:
                throw new Error(`Unknown debug action '${command?.action}'.`);
        }
    }

    /**
     * @private
     * @param {number} siid
     * @param {number} piid
     * @returns {Promise<unknown>}
     */
    async readProperty(siid, piid) {
        this.assertMiotHelper();

        return this.getDebugRobot().miotHelper.readProperty(this.parseId(siid, "siid"), this.parseId(piid, "piid"));
    }

    /**
     * @private
     * @param {number} siid
     * @param {number} piid
     * @param {unknown} value
     * @returns {Promise<void>}
     */
    async writeProperty(siid, piid, value) {
        this.assertMiotHelper();

        await this.getDebugRobot().miotHelper.writeProperty(this.parseId(siid, "siid"), this.parseId(piid, "piid"), value);
    }

    /**
     * @private
     * @param {number} siid
     * @param {number} aiid
     * @param {Array<object>} params
     * @returns {Promise<unknown>}
     */
    async executeAction(siid, aiid, params) {
        this.assertMiotHelper();

        return this.getDebugRobot().miotHelper.executeAction(this.parseId(siid, "siid"), this.parseId(aiid, "aiid"), params);
    }

    /**
     * @private
     * @returns {object}
     */
    getCurrentMapSummary() {
        const map = this.robot.state.map;

        return {
            metaData: map.metaData,
            size: map.size,
            pixelSize: map.pixelSize,
            segments: map.layers
                .filter(layer => layer.type === "segment")
                .map(layer => ({
                    id: layer.metaData.segmentId,
                    name: layer.metaData.name,
                    cleanOrder: layer.metaData.cleanOrder,
                    visible: layer.metaData.dreameVisibility !== false,
                    dreameCleanSet: layer.metaData.dreameCleanSet,
                    dimensions: layer.dimensions
                }))
                .sort((a, b) => (a.cleanOrder ?? Number.MAX_SAFE_INTEGER) - (b.cleanOrder ?? Number.MAX_SAFE_INTEGER))
        };
    }

    /**
     * @private
     * @returns {object|null}
     */
    getDreameMapState() {
        return this.getDebugRobot().dreameMapState ?? null;
    }

    /**
     * @private
     * @returns {Array<object>}
     */
    listUploadedFDSObjects() {
        return Array.from(this.getDebugRobot().uploadedFDSObjectsByName?.entries() ?? []).map(([objectName, data]) => {
            return {
                objectName: objectName,
                length: data.length,
                sha256: crypto.createHash("sha256").update(data).digest("hex")
            };
        });
    }

    /**
     * @private
     * @param {string} objectName
     * @returns {object}
     */
    getUploadedFDSObject(objectName) {
        if (typeof objectName !== "string" || objectName.length === 0) {
            throw new Error("Invalid objectName.");
        }

        const data = this.getDebugRobot().getUploadedFDSData?.(objectName);

        if (!Buffer.isBuffer(data)) {
            throw new Error(`Unknown FDS object '${objectName}'.`);
        }

        return {
            objectName: objectName,
            length: data.length,
            sha256: crypto.createHash("sha256").update(data).digest("hex"),
            base64: data.toString("base64")
        };
    }

    /**
     * @private
     * @param {boolean} force
     */
    assertInactive(force) {
        if (force) {
            return;
        }

        const status = this.robot.state.getFirstMatchingAttribute({
            attributeClass: entities.state.attributes.StatusStateAttribute.name
        });

        if (!["idle", "docked"].includes(status?.value)) {
            throw new Error(`Debug write/action blocked while robot status is '${status?.value}'.`);
        }
    }

    /**
     * @private
     */
    assertMiotHelper() {
        if (!this.getDebugRobot().miotHelper) {
            throw new Error("Robot does not expose a MIOT helper.");
        }
    }

    /**
     * @private
     * @returns {import("../ValetudoRobot") & {
     *     miotHelper?: {
     *         readProperty: (siid: number, piid: number) => Promise<unknown>,
     *         writeProperty: (siid: number, piid: number, value: unknown) => Promise<void>,
     *         executeAction: (siid: number, aiid: number, params: Array<object>) => Promise<unknown>
     *     },
     *     dreameMapState?: object,
     *     uploadedFDSObjectsByName?: Map<string, Buffer>,
     *     getUploadedFDSData?: (objectName: string) => Buffer | undefined
     * }}
     */
    getDebugRobot() {
        return this.robot;
    }

    /**
     * @private
     * @param {unknown} value
     * @param {string} name
     * @returns {number}
     */
    parseId(value, name) {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            throw new Error(`Invalid ${name}.`);
        }

        return value;
    }
}

DebugCapability.TYPE = "DebugCapability";

module.exports = DebugCapability;
