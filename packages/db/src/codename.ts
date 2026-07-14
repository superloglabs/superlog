// Adjective + animal pairs. Generated names are friendly and memorable; the
// pool is intentionally large so collisions inside a single project are rare.
const ADJECTIVES = [
  "amber", "brisk", "cosmic", "dusky", "eager", "feisty", "glacial", "honey",
  "icy", "jolly", "keen", "lanky", "mossy", "nimble", "opal", "plucky",
  "quartz", "rusty", "silky", "tangy", "umber", "velvet", "wispy", "zesty",
  "balmy", "chalky", "drifting", "earnest", "fizzy", "gentle", "hushed", "iridescent",
  "jagged", "kindly", "loamy", "minty", "noble", "ochre", "pearly", "quiet",
  "ruddy", "snowy", "twilight", "ultra", "vivid", "wandering", "youthful",
  "zealous", "ashen", "bouncy", "crisp", "dappled", "ember", "frosted",
  "gilded", "hazy", "inky", "jaunty", "knotty", "luminous", "moonlit",
  "neon", "ornate", "pensive", "queasy", "radiant", "squishy", "tender",
  "uneven", "vaporous", "wistful", "yeasty", "zigzag",
];

const ANIMALS = [
  "narwhal", "otter", "ferret", "axolotl", "tapir", "puffin", "okapi", "lemur",
  "ibex", "wombat", "manatee", "pangolin", "quokka", "capybara", "marmot", "fennec",
  "kiwi", "tanuki", "mongoose", "hedgehog", "raccoon", "porcupine", "platypus",
  "armadillo", "alpaca", "caracal", "civet", "dingo", "echidna", "gerbil",
  "heron", "jackal", "koala", "lynx", "magpie", "newt", "ocelot", "panda",
  "pelican", "quail", "robin", "salamander", "tarsier", "uakari", "vole",
  "walrus", "xerus", "yak", "zebra", "badger", "cuttlefish", "dolphin",
  "egret", "falcon", "gecko", "hare", "iguana", "jellyfish", "kingfisher",
  "loris", "moth", "stoat", "owl", "puma", "ray", "skunk", "toucan",
];

/**
 * Generate a codename like `squishy-narwhal`. Caller is responsible for
 * checking uniqueness within a project and retrying — this is purely a
 * random-pair function.
 */
export function generateCodename(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!;
  return `${adj}-${animal}`;
}
