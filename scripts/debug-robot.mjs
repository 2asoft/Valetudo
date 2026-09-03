#!/usr/bin/env node

const baseUrl = process.env.VALETUDO_URL ?? "http://localhost:3000/api/v2";
const [, , command, ...args] = process.argv;

const usage = () => {
    console.error(`Usage:
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs read <siid> <piid>
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs write <siid> <piid> <json-value> [--force]
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs action <siid> <aiid> <json-params> [--force]
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs map
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs dreame-map-state
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs fds-list
  VALETUDO_URL=http://host/api/v2 node scripts/debug-robot.mjs fds-get <objectName> [output-file]`);
    process.exit(2);
};

const parseNumber = (value, name) => {
    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }

    return parsed;
};

const parseJson = value => {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

const postDebug = async body => {
    const res = await fetch(`${baseUrl}/robot/capabilities/DebugCapability`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body)
    });

    const text = await res.text();

    if (!res.ok) {
        throw new Error(`${res.status} ${text}`);
    }

    if (text.length === 0) {
        return null;
    }

    return JSON.parse(text);
};

const main = async () => {
    let body;

    switch (command) {
        case "read":
            if (args.length !== 2) usage();
            body = {action: "readProperty", siid: parseNumber(args[0], "siid"), piid: parseNumber(args[1], "piid")};
            break;
        case "write":
            if (args.length < 3 || args.length > 4) usage();
            body = {
                action: "writeProperty",
                siid: parseNumber(args[0], "siid"),
                piid: parseNumber(args[1], "piid"),
                value: parseJson(args[2]),
                force: args.includes("--force")
            };
            break;
        case "action":
            if (args.length < 3 || args.length > 4) usage();
            body = {
                action: "executeAction",
                siid: parseNumber(args[0], "siid"),
                aiid: parseNumber(args[1], "aiid"),
                params: parseJson(args[2]),
                force: args.includes("--force")
            };
            break;
        case "map":
            if (args.length !== 0) usage();
            body = {action: "getCurrentMapSummary"};
            break;
        case "dreame-map-state":
            if (args.length !== 0) usage();
            body = {action: "getDreameMapState"};
            break;
        case "fds-list":
            if (args.length !== 0) usage();
            body = {action: "listUploadedFDSObjects"};
            break;
        case "fds-get":
            if (args.length < 1 || args.length > 2) usage();
            body = {action: "getUploadedFDSObject", objectName: args[0]};
            break;
        default:
            usage();
    }

    const result = await postDebug(body);

    if (command === "fds-get" && args[1]) {
        const fs = await import("node:fs");
        fs.writeFileSync(args[1], Buffer.from(result.base64, "base64"));
        console.log(JSON.stringify({
            objectName: result.objectName,
            length: result.length,
            sha256: result.sha256,
            output: args[1]
        }, null, 2));
    } else {
        console.log(JSON.stringify(result, null, 2));
    }
};

main().catch(e => {
    console.error(e.message);
    process.exit(1);
});
