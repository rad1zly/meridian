import { deployHybridPool, deployPosition, getMyPositions } from "./tools/dlmm.js";
console.log("deployHybridPool:", typeof deployHybridPool);
console.log("deployPosition:", typeof deployPosition);
console.log("getMyPositions:", typeof getMyPositions);

// Quick logic check: simulate the split calculation
const config = (await import("./config.js")).config;
const ratio = config.strategy.hybridSpotRatio ?? 0.3;
const total = 1.0;
console.log(`\nWith total=${total} SOL, ratio=${ratio}:`);
console.log(`  spot amount:    ${(total * ratio).toFixed(4)} SOL (${(ratio*100).toFixed(0)}%)`);
console.log(`  bid_ask amount: ${(total * (1-ratio)).toFixed(4)} SOL (${((1-ratio)*100).toFixed(0)}%)`);