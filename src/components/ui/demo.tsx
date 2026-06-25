import React from "react";
import NeuralBackground from "@/components/ui/flow-field-background";

// Reference demo for the NeuralBackground flow-field component.
// The live integration lives in src/components/VolTerminal.jsx, where the
// background is mounted as a fixed, semi-transparent layer behind the desk UI.
export default function NeuralHeroDemo() {
  return (
    // Container must have a defined height, or use h-screen
    <div style={{ position: "relative", width: "100%", height: "100vh" }}>
      <NeuralBackground
        color="#818cf8" // Indigo-400
        trailOpacity={0.1} // Lower = longer trails
        speed={0.8}
      />
    </div>
  );
}
