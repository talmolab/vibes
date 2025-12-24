# SLEAP-NN Config Helper

**Live demo**: https://vibes.tlab.sh/sleap-nn-config-helper/

Generate training configuration files for [SLEAP-NN](https://github.com/talmolab/sleap-nn), the neural network backend for pose estimation in SLEAP.

## Features

- **Load SLEAP Labels (.slp)**: Parse your labeled data to analyze skeleton structure, instance statistics, and video metadata
- **Smart Pipeline Recommendation**: Automatically suggests Single Instance, Top-Down, or Bottom-Up based on your data
- **Dual Config Generation**: Top-Down pipeline generates two separate configs (Centroid + Centered Instance)
- **Visual Configuration**:
  - Crop size visualization with instance bounding box overlay
  - Receptive field coverage indicator
  - Frame viewer with skeleton overlay
- **Complete Training Config**: Backbone, head, augmentation, optimizer, LR scheduler, early stopping
- **Multi-class Support**: Enable identity tracking when tracks are detected in your SLP file
- **Export**: Copy or download YAML configs ready for `sleap-nn-train`

## Usage

1. Load your `.slp` file (drag & drop or file picker)
2. Review the recommended pipeline and data statistics
3. Configure model architecture and training parameters
4. Export the YAML config(s)

### Top-Down Pipeline

Top-Down requires training **two models** in sequence:
1. **Centroid model**: Detects animal locations in full images
2. **Centered Instance model**: Estimates poses on cropped regions

The Config Helper generates both configs with appropriate settings.

## Initial Prompt

> Build a SLEAP-NN Config Helper vibe that helps users generate YAML training configurations for pose estimation. It should:
> - Load .slp files and analyze skeleton/instance statistics
> - Recommend pipeline (Single Instance, Top-Down, Bottom-Up) based on data
> - Generate complete configs with backbone, head, augmentation, training params
> - For Top-Down, generate TWO separate configs (Centroid + Centered Instance)
> - Include visualizations for crop size, receptive field, and frame viewer
> - Support multi-class when tracks are detected
> - Dark theme, sidebar + tabs layout
