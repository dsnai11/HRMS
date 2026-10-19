import { openPglite } from "../server/pglite.js";
import { attendanceCases } from "./attendance-cases.js";

attendanceCases(() => openPglite());
