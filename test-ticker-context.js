import { analyzeTweet, hasMarketContext } from "./lib/extract.js";

const cases = [
  {
    name: "cop car bug",
    text: "My moms car was a Chevy Kingswood, which she would ping pong off every car in the parking lot cause it was so big and my old man drove a Gran Fury as his civilian cop car that we could never touch cause it was loaded with guns lol",
  },
  {
    name: "real cashtag OXY",
    text: "I dumped a lot of my OXY at the long term trend line, working $48 to get them back",
  },
  {
    name: "real ALLCAPS market COP",
    text: "Sold COP into the close, taking profits on the energy trade",
  },
  {
    name: "crude bid",
    text: "I'm $67 bid in crude, the scene of the original crime",
  },
  {
    name: "long AAPL",
    text: "Still long AAPL into earnings next week",
  },
  {
    name: "cashtag COP only",
    text: "Watching $COP for a bounce off support",
  },
];

for (const c of cases) {
  const a = analyzeTweet({
    statusId: "1",
    text: c.text,
    createdAt: "2026-01-01",
  });
  console.log(
    c.name,
    "| market=",
    hasMarketContext(c.text),
    "| dir=",
    a.direction,
    "| inst=",
    a.instruments.map((i) => i.label)
  );
}
