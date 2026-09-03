const CapabilityRouter = require("./CapabilityRouter");

class SegmentPreferencesCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                if (req.query.map_id !== undefined && typeof req.query.map_id !== "string") {
                    res.sendStatus(400);
                    return;
                }

                res.json(await this.capability.getState(req.query.map_id));
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            try {
                switch (req.body.action) {
                    case "set_segment_order":
                        if (Array.isArray(req.body.segment_ids) && req.body.segment_ids.every(segmentId => typeof segmentId === "string")) {
                            await this.capability.setSegmentOrder(req.body.segment_ids, req.body.map_id);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    case "set_segment_preference":
                        if (
                            typeof req.body.segment_id === "string" &&
                            typeof req.body.key === "string" &&
                            typeof req.body.value === "number"
                        ) {
                            await this.capability.setSegmentPreference(req.body.segment_id, req.body.key, req.body.value, req.body.map_id);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    case "set_segment_visibility":
                        if (typeof req.body.segment_id === "string" && typeof req.body.visibility === "string") {
                            await this.capability.setSegmentVisibility(req.body.segment_id, req.body.visibility, req.body.map_id);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    default:
                        res.sendStatus(400);
                }
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = SegmentPreferencesCapabilityRouter;
