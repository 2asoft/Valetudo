const CapabilityRouter = require("./CapabilityRouter");

class MultiMapControlCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.capability.getState());
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.get("/maps/:map_id/preview", async (req, res) => {
            try {
                res.json(await this.capability.getMapPreview(req.params.map_id));
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            try {
                switch (req.body.action) {
                    case "select_map":
                        if (typeof req.body.map_id === "string") {
                            await this.capability.selectMap(req.body.map_id);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    case "rename_map":
                        if (typeof req.body.map_id === "string" && typeof req.body.name === "string") {
                            await this.capability.renameMap(req.body.map_id, req.body.name);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    case "delete_map":
                        if (typeof req.body.map_id === "string") {
                            await this.capability.deleteMap(req.body.map_id);
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(400);
                        }
                        break;
                    case "rotate_map":
                        if (typeof req.body.map_id === "string" && typeof req.body.rotation === "number") {
                            await this.capability.rotateMap(req.body.map_id, req.body.rotation);
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

module.exports = MultiMapControlCapabilityRouter;
