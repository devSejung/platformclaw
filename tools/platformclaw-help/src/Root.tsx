import React from "react";
import { Composition } from "remotion";
import { HelpClip } from "./HelpClip";
import { topics } from "./topics";
export const Root: React.FC = () => (
  <>
    {topics.map((topic) => (
      <Composition
        key={topic.id}
        id={topic.composition}
        component={HelpClip}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={topic.seconds * 30}
        defaultProps={{ topicId: topic.id, locale: "ko" as const }}
      />
    ))}
  </>
);
