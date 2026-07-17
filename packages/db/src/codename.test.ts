import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADJECTIVES, ANIMALS, generateCodename } from "./codename.js";

// Minimum unique codename combinations required. Projects accumulate incidents
// over their lifetime and their codenames are never freed (the unique index
// persists for resolved/merged incidents too). A pool that is too small leads
// to allocation failures when all 6 retry attempts collide.
//
// At 20 000 unique combinations, a project would need ~18 000 incidents before
// any single random pick has a >90% collision probability.
const MIN_UNIQUE_POOL = 20_000;

describe("generateCodename", () => {
  it("returns a non-empty hyphen-separated string", () => {
    const name = generateCodename();
    assert.ok(name.length > 0, "codename must not be empty");
    assert.ok(name.includes("-"), "codename must contain a hyphen");
  });

  it("returns only lowercase letters and hyphens", () => {
    for (let i = 0; i < 200; i++) {
      const name = generateCodename();
      assert.match(
        name,
        /^[a-z]+-[a-z]+$/,
        `codename "${name}" must match /^[a-z]+-[a-z]+$/`,
      );
    }
  });

  it("word lists contain no duplicates", () => {
    const adjSet = new Set(ADJECTIVES);
    assert.equal(
      adjSet.size,
      ADJECTIVES.length,
      `ADJECTIVES contains ${ADJECTIVES.length - adjSet.size} duplicate(s)`,
    );

    const animalSet = new Set(ANIMALS);
    assert.equal(
      animalSet.size,
      ANIMALS.length,
      `ANIMALS contains ${ANIMALS.length - animalSet.size} duplicate(s)`,
    );
  });

  it(`unique codename pool is at least ${MIN_UNIQUE_POOL.toLocaleString()}`, () => {
    const uniqueAdj = new Set(ADJECTIVES).size;
    const uniqueAnimal = new Set(ANIMALS).size;
    const pool = uniqueAdj * uniqueAnimal;
    assert.ok(
      pool >= MIN_UNIQUE_POOL,
      `pool is only ${pool.toLocaleString()} (${uniqueAdj} adj × ${uniqueAnimal} animals); ` +
        `expand ADJECTIVES and/or ANIMALS in codename.ts to reach ${MIN_UNIQUE_POOL.toLocaleString()}+. ` +
        "Projects accumulate incidents over their lifetime and codenames are never freed.",
    );
  });
});
