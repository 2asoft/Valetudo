const CapabilityRouter = require("./CapabilityRouter");

class DebugCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.post("/", this.validator, async (req, res) => {
            try {
                res.json(await this.capability.execute(req.body));
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = DebugCapabilityRouter;
