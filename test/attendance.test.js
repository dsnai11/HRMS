import { openDatabase } from "../server/db.js";
import { attendanceCases } from "./attendance-cases.js";
attendanceCases(() => openDatabase(":memory:"));
