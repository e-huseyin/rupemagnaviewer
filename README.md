# Rupe Magna Viewer: An Interactive Web-Based Visualisation of RTI Documentation

**Live Demonstration:** **[http://e-huseyin.github.io/rupemagnaviewer](http://e-huseyin.github.io/rupemagnaviewer)**

## Overview

The Rupe Magna Viewer is an open-access, web-based platform designed to present the high-resolution Reflectance Transformation Imaging (RTI) documentation of the Rupe Magna rock art site in Grosio, Italy. This project is the principal dissemination output of the Master's Thesis, *"Digital Documentation of the Rupe Magna: A FAIR Data Framework and a Portable RTI Dome"* (Hüseyin Erdoğan, University of Bologna, 2025).

This viewer provides the first interactive, dome-based RTI documentation for the Rupe Magna Archaeological Park, one of the largest and most significant engraved rock surfaces in the Alpine region. Moving beyond static imagery, it offers a dynamic and explorable resource for both academic researchers and the wider public. The project's methodology is grounded in the principles of the London Charter and FAIR data, ensuring that the digital outputs function as a verifiable chain of evidence, promoting transparency, reusability, and open scholarship in digital archaeology.

## The Dataset: Rupe Magna Engravings

The RTI datasets presented in this viewer were acquired during a dedicated fieldwork campaign in September 2025. The data was captured using a custom-designed and constructed **portable RTI dome**, which combines the precision of laboratory systems with the robustness required for in-situ archaeological documentation.

A total of eleven engravings, spanning anthropomorphic, zoomorphic, and geometric figures from the Late Neolithic to the Iron Age, were documented. Each figure can be interactively examined to reveal micro-topographical details, such as tool marks and faint incisions, that are often invisible to the naked eye.

## Methodology and Technical Implementation

The viewer's technical architecture was developed to provide a powerful, efficient, and analytically versatile user experience directly within a standard web browser.

### Core Framework: OpenLIME

The interface is built upon **[OpenLIME (Open Layered IMage Explorer)](https://github.com/cnr-isti-vclab/openlime)**, an open and flexible web framework for creating and exploring complex, relightable image models. The choice of OpenLIME was strategic for several reasons:
*   **High Performance:** Its data-flow approach enables the efficient streaming of large, multi-channel RTI datasets, ensuring smooth interaction even with high-resolution models.
*   **Advanced Visualisation:** It leverages customisable WebGL shaders to facilitate advanced, real-time visualisation modes beyond simple relighting.
*   **Extensibility:** The framework's modular structure allows for the integration of custom analytical tools and multifaceted visualisations.

### Data Processing and Formats

All raw datasets were processed using **[RelightLab](https://github.com/cnr-isti-vclab/relight)**, an open-source tool chosen for its stable performance, low computational requirements, and seamless integration with the OpenLIME ecosystem. The viewer primarily utilises web-optimised **PTM (Polynomial Texture Maps)** and **HSH (Hemispherical Harmonics)** formats, rendered using DeepZoom tiled image technology for rapid and efficient visualisation.

### Custom Analytical Features

To enhance the analytical capabilities beyond the standard OpenLIME toolset, several custom features were implemented:
*   **Interactive Measurement Tools:** A dynamic scale bar and a point-to-point measurement tool (ruler) allow for metric analysis of the engravings.
*   **Enhanced Navigation:** Users can rotate the imagery, fix a specific lighting angle for consistent examination, and capture snapshots of their views for documentation and comparison.
*   **Vector Overlay:** A dedicated layer allows for the visual superimposition of historical *rilievo a contatto* (contact tracing) drawings. This enables a direct comparison between traditional interpretative documentation and the empirical micro-topographical data provided by RTI.
*   **Lens Functionality:** A dynamic 'lens' can be activated to view a localised area of the surface in an alternative rendering mode (e.g., Normals Visualisation) while the surrounding context remains in the standard RTI view. This facilitates a nuanced, multi-layered examination of surface details.

---

## User Guide

The viewer provides several interactive tools to facilitate detailed analysis. Below is a guide to the key controls and features.

### 💡 Light Control
The virtual light source is the primary tool for examining surface topography.
*   **Activate Light Control:** Click the light icon in the bottom toolbar or press the **`L`** key.
*   **Reposition the Light:** Move the mouse across the viewing area to change the light direction. Reference lines will appear to help visualise the light's orientation.

### 🎨 Image Rendering Modes
The viewer supports multiple rendering modes, accessible via the **Layers** panel on the left. Each mode isolates different surface properties:
*   **Light:** Standard interactive RTI visualisation.
*   **Normals:** A false-colour map representing the orientation of surface normals.
*   **Diffuse:** Isolates the intrinsic colour (albedo) of the surface by removing shadows.
*   **Specular:** Enhances specular reflections to highlight fine surface texture and material variations.

### 🔍 Interactive Lens (Magnifier)
*   **Toggle the Lens:** Press the **`M`** key to activate or deactivate the lens.
*   **Functionality:** The lens displays a circular area with an alternative rendering mode (by default, the *Normals* map from the 'Lens Preview' layer), allowing for direct comparison with the standard RTI view in the surrounding area.
*   **Move the Lens:** Click and drag the circular area to reposition it.
*   **Resize the Lens:** Use the mouse wheel while the cursor is inside the lens.

### 📏 Measurement Tool (Ruler)
*   **Activate the Ruler:** Press the **`C`** key.
*   **Measure:** A crosshair cursor (`+`) will appear. Click on two different points on the image to measure the distance between them.

### ⌨️ Keyboard Shortcuts
A summary of keyboard shortcuts for quick access to tools:

| Key | Action |
| :---: | :--- |
| **`M`** | Toggle Interactive Lens (Magnifier) |
| **`C`** | Toggle Measurement Tool (Ruler) |
| **`V`** | Toggle Vector Layer |
| **`A`** | Toggle Annotation Layer |
| **`R`** | Rotate |
| **`L`** | Light Control |
| **`Home`** | Return to Main View |
| **`+` / `-`** | Zoom In / Zoom Out |

---

## Citation

This work is an outcome of academic research. If you use or refer to this project in your own work, please cite the original thesis:
> Erdoğan, H. (2025). *Digital Documentation of the Rupe Magna: A FAIR Data Framework and a Portable RTI Dome*. [Master's Thesis, Università di Bologna]. Dipartimento di Storia Culture Civiltà, Alma Mater Studiorum - Università di Bologna.

## License

The source code for this viewer is made available under the [MIT License](LICENSE). The RTI datasets and associated metadata are provided for academic and non-commercial use.

## Acknowledgements

This project was made possible through the support of the Dipartimento di Storia Culture Civiltà at the University of Bologna and the operational support of the Parco delle Incisioni Rupestri di Grosio-Grosotto. Special thanks to Prof. Cristiano Putzolu, Prof. Federico Zoni, and Prof.ssa Valentina Presutti for their guidance. The development of the viewer relies on the excellent open-source tools developed by the Visual Computing Lab (ISTI-CNR), particularly OpenLIME and RelightLab.