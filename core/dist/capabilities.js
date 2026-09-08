export const CAPABILITIES = [
    { id: "control", name: "Command Control", summary: "Rendezvous with the organization: what needs you, what changed, what came back.", route: "#/control" },
    { id: "ideas", name: "Idea Room", summary: "Private windows, notes, seeds; hand a note to Conjure deliberately.", route: "#/ideas" },
    { id: "network", name: "Network", summary: "The spatial truth of the machine: seats, occupancy, obligations, the circuit.", route: "#/network" },
    { id: "judgments", name: "Judgments", summary: "Product and technical decisions the organization genuinely owes you.", route: "#/judgments" },
    { id: "directive", name: "Directive", summary: "Give an order; intake clarifies it into a contract Conjure carries.", route: "#/directive" },
    { id: "workflow", name: "Workflow designer", summary: "Draw the circuit; designed, compiled and live are kept distinct.", route: "#/workflow" },
    { id: "homework", name: "Homework", summary: "The questions worth your attention as one sheet; answer, submit, watch ignition.", route: "#/homework" },
    { id: "meetings", name: "Meetings", summary: "Organization around meetings held elsewhere: purpose, time, agenda, outcome, decisions.", route: "#/meetings" },
    { id: "people", name: "People and waits", summary: "External humans as cold dependencies: who is owed what, shown on Network's OUTSIDE plane.", route: "#/network" },
    { id: "self", name: "Conjure itself", summary: "Editions, provenance and skew: what exists versus what is running.", route: "#/control" },
    { id: "tools", name: "Tools", summary: "Real programs (Godot, Aseprite, ...) as capabilities granted to seats; probed cold, told to workers, never briefed.", route: "#/network/machine" },
    { id: "frontier", name: "Experimental providers", summary: "Try a new model or CLI today from a JSON spec; windows only until promoted to the organization.", route: "#/network/machine" },
    { id: "container", name: "Desktop container awareness", summary: "The machine knows which container operates it and says so in its own truth.", route: "#/control" },
];
export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);
export function capabilityName(id) { return CAPABILITIES.find((c) => c.id === id)?.name ?? id; }
//# sourceMappingURL=capabilities.js.map