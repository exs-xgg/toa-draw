'use strict';

// Default word pool. Hosts can add their own words in room settings.
const WORDS = `
apple, banana, cherry, grapes, lemon, pineapple, watermelon, carrot, broccoli, mushroom,
pizza, burger, hot dog, sandwich, taco, sushi, noodles, pancake, donut, cupcake,
ice cream, popcorn, cookie, cheese, egg, bread, coffee, teapot, milkshake, lollipop,
cat, dog, horse, cow, pig, sheep, chicken, duck, rabbit, mouse,
lion, tiger, elephant, giraffe, zebra, monkey, gorilla, kangaroo, koala, panda,
bear, wolf, fox, deer, camel, crocodile, snake, turtle, frog, lizard,
shark, whale, dolphin, octopus, jellyfish, crab, lobster, starfish, penguin, owl,
eagle, parrot, flamingo, peacock, butterfly, bee, spider, snail, ant, ladybug,
house, castle, igloo, tent, lighthouse, windmill, bridge, tower, pyramid, skyscraper,
car, bus, train, bicycle, motorcycle, airplane, helicopter, rocket, boat, submarine,
tractor, ambulance, fire truck, taxi, scooter, skateboard, hot air balloon, parachute, anchor, sailboat,
sun, moon, star, cloud, rainbow, lightning, snowman, tornado, volcano, mountain,
island, beach, desert, forest, river, waterfall, cave, planet, comet, galaxy,
tree, flower, cactus, palm tree, leaf, mushroom house, sunflower, rose, pumpkin, acorn,
chair, table, bed, sofa, lamp, clock, mirror, door, window, stairs,
television, computer, laptop, phone, camera, headphones, keyboard, robot, battery, light bulb,
book, pencil, scissors, ruler, backpack, envelope, calendar, map, globe, magnet,
hammer, saw, screwdriver, ladder, bucket, shovel, wheelbarrow, toolbox, key, lock,
hat, crown, glasses, shoe, sock, glove, scarf, umbrella, watch, ring,
shirt, dress, jacket, tie, belt, boot, sandal, helmet, mask, wallet,
guitar, piano, drum, violin, trumpet, microphone, headband, saxophone, harp, bell,
football, basketball, tennis, golf, bowling, surfing, skiing, swimming, boxing, archery,
trophy, medal, kite, yo-yo, puzzle, dice, chess, balloon, gift, candle,
doctor, teacher, chef, pilot, farmer, firefighter, police officer, astronaut, pirate, wizard,
king, queen, knight, ninja, vampire, ghost, zombie, mermaid, dragon, unicorn,
heart, brain, skeleton, tooth, eye, nose, ear, hand, foot, mustache,
running, jumping, sleeping, dancing, swimming pool, fishing, cooking, painting, singing, laughing,
birthday cake, campfire, fireworks, treasure chest, message in a bottle, sandcastle, roller coaster, ferris wheel, circus, haunted house,
toothbrush, soap, towel, bathtub, toilet, shower, comb, hairdryer, lipstick, perfume,
fridge, oven, microwave, toaster, kettle, fork, spoon, knife, plate, frying pan,
traffic light, stop sign, fountain, statue, playground, swing, slide, bench, mailbox, garbage can,
spaceship, alien, satellite, telescope, black hole, meteor, moon landing, astronaut helmet, ufo, solar panel,
spreadsheet, calculator, invoice, receipt, piggy bank, coin, briefcase, stapler, paperclip, sticky note
`
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

// Seasonal words, used while the Christmas theme is on (see THEME in room.js).
const HOLIDAY_WORDS = `
christmas tree, snowflake, gingerbread man, gingerbread house, candy cane, reindeer, sleigh, stocking,
ornament, mistletoe, wreath, present, elf, santa, snow globe, hot chocolate, fireplace, chimney,
nutcracker, angel, ice skates, sled, mittens, snowball, icicle, holly, eggnog, christmas lights,
advent calendar, north pole, polar bear, toy soldier, fruitcake, ugly sweater, christmas card,
wrapping paper, tinsel, carolers, snow angel, bauble, sleigh bells, snowy village, cookie jar, red nose
`
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

module.exports = { WORDS: [...new Set(WORDS)], HOLIDAY_WORDS: [...new Set(HOLIDAY_WORDS)] };
