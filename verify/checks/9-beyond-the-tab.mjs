export default {
  task: 9,
  name: "Beyond the open tab",
  goal: "EV is useful when the person is not looking at it: it reaches them when something needs them, and it watches the things they asked it to watch, telling them first and acting only inside what they allowed.",
  live: [
    "No scenario yet: it needs the channel decision."
  ],
  checks: [
    {
      id: "N-01",
      expect: "When work finishes or needs the person and the page is closed, EV reaches them once through the channel they chose.",
      needs: "your decision on which single channel that is"
    },
    {
      id: "N-02",
      expect: "A standing responsibility starts in observe mode: EV notices and tells the person, and starts no work until they say so.",
      needs: "standing work moved onto OpenClaw first"
    }
  ]
};
