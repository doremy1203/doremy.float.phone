import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-location-import.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, console }, { filename: "life-location-import.cjs" });
const { mergeImportedLifeLocations, parseImportedLifeLocations } = moduleBox.exports;

const now = "2026-11-15T00:00:00.000Z";
const sourceA = { sourceKey: "worldbook:book-a:entry-1", kind: "worldbook", worldBookId: "book-a", worldBookName: "城市设定", entryUid: "entry-1", importedAt: now };
const sourceB = { sourceKey: "worldbook:book-b:entry-2", kind: "worldbook", worldBookId: "book-b", worldBookName: "角色设定", entryUid: "entry-2", importedAt: now };

const parsed = parseImportedLifeLocations([
  { name: "旧城区花店", aliases: ["花店", "旧城花房"], description: "临街的小花店。", atmosphere: "安静、明亮。", layout: "入口朝向街道，柜台靠右。", props: ["花桶", "剪刀"], relation: "frequent", sourceKeys: [sourceA.sourceKey] },
  { name: "旧城区花店", aliases: ["花房"], sourceKeys: [sourceB.sourceKey] },
  { name: "旧城花店", sourceKeys: ["not-a-real-source"] },
], new Map([[sourceA.sourceKey, sourceA], [sourceB.sourceKey, sourceB]]));
assert.equal(parsed.length, 2, "unknown source keys must be rejected, not imported");
const merged = mergeImportedLifeLocations([], parsed);
assert.equal(merged.added, 1, "same exact canonical place should deduplicate");
assert.equal(merged.locations[0].name, "旧城区花店");
assert.deepEqual(Array.from(merged.locations[0].aliases), ["花店", "旧城花房", "花房"]);
assert.equal(merged.locations[0].sourceRefs.length, 2, "repeated imports should merge provenance");
assert.equal(merged.locations[0].description, "临街的小花店。");
assert.equal(merged.locations[0].fieldOrigins.description, "ai");
const refreshedSource = { ...sourceA, worldBookName: "城市设定（更新名）", importedAt: "2026-11-16T00:00:00.000Z" };
const sourceRefresh = mergeImportedLifeLocations(merged.locations, [{ name: "旧城区花店", sourceRefs: [refreshedSource] }]);
assert.equal(sourceRefresh.locations[0].sourceRefs.length, 2, "reimport must not duplicate a source reference");
assert.equal(sourceRefresh.locations[0].sourceRefs[0].worldBookName, "城市设定（更新名）", "reimport should refresh source labels");

const userAuthored = {
  id: "place-user-shop", name: "旧城区花店", description: "用户手动确认的店铺描述。",
  atmosphere: "用户设定的气氛。", layout: "用户设定的布局。", props: ["用户添加的花瓶"],
  aliases: ["花店"], fieldOrigins: { description: "user", atmosphere: "user", layout: "user", props: "user", aliases: "user" },
  visibility: "public",
};
const refreshed = mergeImportedLifeLocations([userAuthored], [{
  name: "旧城区花店", description: "AI 新描述", atmosphere: "AI 新氛围", layout: "AI 新布局",
  props: ["AI 新道具"], aliases: ["新的别名"], sourceRefs: [sourceA],
}]);
assert.equal(refreshed.locations[0].description, userAuthored.description, "refresh must not overwrite manual description");
assert.equal(refreshed.locations[0].atmosphere, userAuthored.atmosphere, "refresh must not overwrite manual atmosphere");
assert.equal(refreshed.locations[0].layout, userAuthored.layout, "refresh must not overwrite manual layout");
assert.deepEqual(Array.from(refreshed.locations[0].props), userAuthored.props, "refresh must not overwrite manual props");
assert.deepEqual(Array.from(refreshed.locations[0].aliases), userAuthored.aliases, "refresh must not overwrite manual aliases");
assert.equal(refreshed.locations[0].sourceRefs.length, 1, "source references still merge when manual fields are protected");

const aiAuthored = { ...userAuthored, id: "place-ai-shop", fieldOrigins: { description: "ai", atmosphere: "ai", layout: "ai", props: "ai", aliases: "ai" } };
const refreshedAi = mergeImportedLifeLocations([aiAuthored], [{
  name: "旧城区花店", description: "更新后的描述", atmosphere: "更新后的氛围", layout: "更新后的布局",
  props: ["更新道具"], aliases: ["更新别名"], sourceRefs: [sourceB],
}]);
assert.equal(refreshedAi.locations[0].description, "更新后的描述", "AI-generated fields should be refreshable");
assert.deepEqual(Array.from(refreshedAi.locations[0].props), ["更新道具"]);

const scheduleStub = { id: "schedule-place-flower-shop", name: "花店", description: "由角色日程自动同步建立；可在地点库中继续编辑。", atmosphere: "", layout: "", props: [], visibility: "public" };
const enrichedStub = mergeImportedLifeLocations([scheduleStub], [{
  name: "旧城区花店", aliases: ["花店"], description: "有自然光的临街花店。",
  atmosphere: "安静。", layout: "柜台靠右。", props: ["花桶"], sourceRefs: [sourceA],
}]);
assert.equal(enrichedStub.locations[0].id, scheduleStub.id, "enriching a schedule placeholder should preserve its existing ID");
assert.equal(enrichedStub.locations[0].description, "有自然光的临街花店。", "import should replace schedule placeholder boilerplate");
assert.ok(enrichedStub.locations[0].aliases.includes("旧城区花店"), "the imported canonical name should become an alias without renaming a user-visible place");

const similar = mergeImportedLifeLocations([], [
  { name: "旧城区花店", sourceRefs: [sourceA] },
  { name: "旧城区花店旁边的咖啡馆", sourceRefs: [sourceB] },
]);
assert.equal(similar.added, 2, "similar names must not be fuzzy-merged");
assert.notEqual(similar.locations[0].id, similar.locations[1].id);
assert.ok(similar.locations[0].id.startsWith("imported-place-"), "imported location IDs should be deterministic slugs");

const ownHomeSource = { ...sourceA, sourceKey: "character-card:character-a", kind: "character-card", characterId: "character-a" };
const importedHome = mergeImportedLifeLocations([], [{
  name: "海边公寓", relation: "own-home", sourceRefs: [ownHomeSource],
}]);
assert.equal(importedHome.locations[0].id, "home-character-a", "a character's own residence must use the canonical home-<characterId> ID");
assert.equal(importedHome.locations[0].visibility, "private", "personal residences should remain private");
const existingHome = { id: "home-character-a", name: "A的家", visibility: "private", description: "existing", residents: ["character-a"] };
const mergedHome = mergeImportedLifeLocations([existingHome], [{
  name: "海边公寓", relation: "own-home", sourceRefs: [ownHomeSource],
}]);
assert.equal(mergedHome.locations.length, 1, "an imported own-home should merge into the existing canonical residence");
assert.equal(mergedHome.locations[0].id, "home-character-a");
assert.ok(mergedHome.locations[0].aliases.includes("海边公寓"), "the imported residence name should become a matchable alias");

const playerHome = { id: "home", name: "玩家的家", visibility: "private", residents: [] };
const sharedHome = mergeImportedLifeLocations([playerHome], [{ name: "我们共同的家", relation: "shared-home", sourceRefs: [{ ...ownHomeSource, sourceKey: "character-card:character-b", characterId: "character-b" }] }]);
assert.equal(sharedHome.locations.length, 1, "a home explicitly shared with the player should merge into the player home");
assert.equal(sharedHome.locations[0].id, "home");
assert.ok(sharedHome.locations[0].residents.includes("character-b"), "shared-home import should register the character as a resident");


console.log("Life location import regression tests passed.");
