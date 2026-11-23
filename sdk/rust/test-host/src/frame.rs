//! Frames: RGB bytes, their hash, and PNG files.

use std::path::Path;

use sha2::{Digest, Sha256};

/// A composed frame: RGB, 8 bits a channel, rows top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// `width * height * 3` bytes.
    pub rgb: Vec<u8>,
}

impl Frame {
    /// An all-black frame.
    #[must_use]
    pub fn black(width: usize, height: usize) -> Frame {
        Frame { width, height, rgb: vec![0; width * height * 3] }
    }

    /// The SHA-256 of the raw bytes, in lower-case hex.
    #[must_use]
    pub fn sha256(&self) -> String {
        Sha256::digest(&self.rgb).iter().fold(String::new(), |mut s, b| {
            s.push_str(&format!("{b:02x}"));
            s
        })
    }

    /// The pixel at `(x, y)`.
    #[must_use]
    pub fn pixel(&self, x: usize, y: usize) -> [u8; 3] {
        let o = (y * self.width + x) * 3;
        [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]]
    }

    /// The first pixel (in reading order) where the frames differ: `(x, y, self's, other's)`.
    #[must_use]
    pub fn first_difference(&self, other: &Frame) -> Option<(usize, usize, [u8; 3], [u8; 3])> {
        if self.width != other.width || self.height != other.height {
            return Some((0, 0, self.pixel(0, 0), [0, 0, 0]));
        }
        (0..self.height * self.width).map(|i| (i % self.width, i / self.width)).find(|&(x, y)| self.pixel(x, y) != other.pixel(x, y)).map(|(x, y)| (x, y, self.pixel(x, y), other.pixel(x, y)))
    }

    /// Writes the frame as an 8-bit RGB PNG.
    ///
    /// # Errors
    /// The I/O or encoding error as text.
    pub fn write_png(&self, path: &Path) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), u32::try_from(self.width).map_err(|e| e.to_string())?, u32::try_from(self.height).map_err(|e| e.to_string())?);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&self.rgb).map_err(|e| e.to_string())
    }

    /// Reads an 8-bit RGB PNG.
    ///
    /// # Errors
    /// The I/O or decoding error as text, or a PNG that is not 8-bit RGB.
    pub fn read_png(path: &Path) -> Result<Frame, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut reader = png::Decoder::new(std::io::BufReader::new(file)).read_info().map_err(|e| format!("{}: {e}", path.display()))?;
        let mut buf = vec![0; reader.output_buffer_size().ok_or("PNG too large")?];
        let info = reader.next_frame(&mut buf).map_err(|e| format!("{}: {e}", path.display()))?;
        if info.color_type != png::ColorType::Rgb || info.bit_depth != png::BitDepth::Eight {
            return Err(format!("{}: not an 8-bit RGB PNG", path.display()));
        }
        buf.truncate(info.buffer_size());
        Ok(Frame { width: info.width as usize, height: info.height as usize, rgb: buf })
    }
}
