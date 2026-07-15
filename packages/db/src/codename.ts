// Adjective + animal pairs. Generated names are friendly and memorable; the
// pool is intentionally large so collisions inside a single project are rare
// even as incident counts grow into the thousands.
//
// Pool size: len(ADJECTIVES) × len(ANIMALS) unique combinations. Verify with
// the codename.test.ts invariant test before reducing either list.
export const ADJECTIVES = [
  // Original set
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
  // Extended set
  "breezy", "caramel", "cinder", "cobalt", "copper", "coral", "crimson", "crystal",
  "curly", "dawn", "deep", "dense", "dewy", "dim", "dotted", "earthy",
  "eerie", "electric", "faded", "fiery", "floral", "fluffy", "foggy", "frothy",
  "furry", "gloomy", "glowing", "golden", "gritty", "gusty", "hollow", "indigo",
  "jade", "lavender", "leafy", "lofty", "mahogany", "mellow", "murky", "mystic",
  "narrow", "navy", "northern", "olive", "onyx", "pale", "pastel", "pewter",
  "pine", "prism", "pudgy", "pungent", "rich", "rocky", "rosy", "sandy",
  "scarlet", "serene", "shadowy", "shaggy", "sheer", "silver", "slate", "sleek",
  "slim", "smoky", "solar", "spicy", "stark", "steep", "stormy", "striped",
  "subtle", "sunny", "swift", "tawny", "thorny", "tidal", "timber", "topaz",
  "turquoise", "velvety", "verdant", "volcanic", "warm", "windy", "wooly",
];

export const ANIMALS = [
  // Original set (duplicate "narwhal" removed)
  "narwhal", "otter", "ferret", "axolotl", "tapir", "puffin", "okapi", "lemur",
  "ibex", "wombat", "manatee", "pangolin", "quokka", "capybara", "marmot", "fennec",
  "kiwi", "tanuki", "mongoose", "hedgehog", "raccoon", "porcupine", "platypus",
  "armadillo", "alpaca", "caracal", "civet", "dingo", "echidna", "gerbil",
  "heron", "jackal", "koala", "lynx", "magpie", "newt", "ocelot", "panda",
  "pelican", "quail", "robin", "salamander", "tarsier", "uakari", "vole",
  "walrus", "xerus", "yak", "zebra", "badger", "cuttlefish", "dolphin",
  "egret", "falcon", "gecko", "hare", "iguana", "jellyfish", "kingfisher",
  "loris", "moth", "owl", "puma", "ray", "skunk", "toucan",
  // Extended set
  "aardvark", "albatross", "anaconda", "antelope", "baboon", "barracuda",
  "beaver", "bison", "boa", "boar", "bobcat", "bongo", "buffalo", "bullfrog",
  "butterfly", "cassowary", "catfish", "cheetah", "chinchilla", "chipmunk",
  "clownfish", "cobra", "condor", "cormorant", "coyote", "crab", "crane",
  "cricket", "crocodile", "crow", "deer", "dragonfly", "dugong", "dunlin",
  "elk", "emu", "finch", "flamingo", "fox", "frog", "gazelle", "gibbon",
  "giraffe", "gnu", "gorilla", "grasshopper", "grouse", "hamster", "hawk",
  "hippo", "horse", "hummingbird", "hyena", "impala", "jaguar", "kangaroo",
  "kestrel", "lamprey", "lark", "leopard", "lion", "lizard", "llama",
  "lobster", "macaw", "mantis", "meerkat", "mink", "mole", "moose",
  "mussel", "opossum", "orangutan", "ostrich", "oyster", "parrot", "peacock",
  "pheasant", "pigeon", "piranha", "pony", "python", "quetzal", "rabbit",
  "raven", "rhino", "scorpion", "seahorse", "seal", "shark", "sheep",
  "shrimp", "sloth", "snail", "sparrow", "spider", "squid", "squirrel",
  "stag", "starfish", "stork", "swallow", "swan", "tiger", "tortoise",
  "trout", "turkey", "turtle", "viper", "vulture", "weasel", "whale",
  "wolf", "woodpecker", "wren",
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
