//! Finds the `__KEMUDI_EXIT:<code>` line that action tabs print when their
//! command finishes, strips it from the output stream, and reports the code.
//!
//! The marker can be split across PTY reads, so bytes that might be the start
//! of a marker are held back until the next chunk decides. Only the first
//! marker counts; after that the scanner is a pass-through, so an interactive
//! shell left open in the tab never has its output delayed.

pub const MARKER: &[u8] = b"__KEMUDI_EXIT:";
const MAX_DIGITS: usize = 3;

#[derive(Debug, PartialEq, Eq)]
pub enum Segment {
    Data(Vec<u8>),
    Exit(i32),
}

#[derive(Debug, Default)]
pub struct MarkerScanner {
    pending: Vec<u8>,
    done: bool,
}

impl MarkerScanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<Segment> {
        if self.done {
            return data_segment(input).into_iter().collect();
        }
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(input);

        let mut out = Vec::new();
        let mut i = 0;
        while let Some(rel) = find(&buf[i..], MARKER) {
            let start = i + rel;
            match parse_marker(&buf[start + MARKER.len()..]) {
                Parse::Incomplete => {
                    out.extend(data_segment(&buf[i..start]));
                    self.pending = buf[start..].to_vec();
                    return out;
                }
                Parse::NotMarker => {
                    // Emit the lookalike verbatim and keep scanning after it.
                    let after = start + MARKER.len();
                    out.extend(data_segment(&buf[i..after]));
                    i = after;
                }
                Parse::Marker { code, len } => {
                    out.extend(data_segment(&buf[i..start]));
                    out.push(Segment::Exit(code));
                    out.extend(data_segment(&buf[start + MARKER.len() + len..]));
                    self.done = true;
                    return out;
                }
            }
        }
        let hold = suffix_prefix_len(&buf[i..], MARKER);
        out.extend(data_segment(&buf[i..buf.len() - hold]));
        self.pending = buf[buf.len() - hold..].to_vec();
        out
    }

    /// Release anything still held back (call on EOF).
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        let rest = std::mem::take(&mut self.pending);
        (!rest.is_empty()).then_some(rest)
    }
}

enum Parse {
    Incomplete,
    NotMarker,
    /// `len` counts the digits and line terminator after the marker prefix.
    Marker {
        code: i32,
        len: usize,
    },
}

fn parse_marker(rest: &[u8]) -> Parse {
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits > MAX_DIGITS {
        return Parse::NotMarker;
    }
    if digits == rest.len() {
        return Parse::Incomplete;
    }
    if digits == 0 {
        return Parse::NotMarker;
    }
    let term = match (rest.get(digits), rest.get(digits + 1)) {
        (Some(b'\n'), _) => 1,
        (Some(b'\r'), Some(b'\n')) => 2,
        (Some(b'\r'), None) => return Parse::Incomplete,
        _ => return Parse::NotMarker,
    };
    let code = std::str::from_utf8(&rest[..digits])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(-1);
    Parse::Marker {
        code,
        len: digits + term,
    }
}

fn data_segment(bytes: &[u8]) -> Option<Segment> {
    (!bytes.is_empty()).then(|| Segment::Data(bytes.to_vec()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Length of the longest suffix of `buf` that is a proper prefix of `needle`.
fn suffix_prefix_len(buf: &[u8], needle: &[u8]) -> usize {
    (1..needle.len().min(buf.len() + 1))
        .rev()
        .find(|&n| buf.ends_with(&needle[..n]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> (Vec<u8>, Vec<i32>) {
        let mut s = MarkerScanner::new();
        let mut data = Vec::new();
        let mut codes = Vec::new();
        for c in chunks {
            for seg in s.feed(c) {
                match seg {
                    Segment::Data(d) => data.extend(d),
                    Segment::Exit(c) => codes.push(c),
                }
            }
        }
        if let Some(rest) = s.flush() {
            data.extend(rest);
        }
        (data, codes)
    }

    #[test]
    fn strips_marker_in_one_chunk() {
        let (data, codes) = run(&[b"Already up to date.\r\n\r\n__KEMUDI_EXIT:0\r\nprompt$ "]);
        assert_eq!(data, b"Already up to date.\r\n\r\nprompt$ ");
        assert_eq!(codes, vec![0]);
    }

    #[test]
    fn marker_split_at_every_position() {
        let full: &[u8] = b"out\r\n__KEMUDI_EXIT:130\r\n$ ";
        for cut in 0..=full.len() {
            let (data, codes) = run(&[&full[..cut], &full[cut..]]);
            assert_eq!(data, b"out\r\n$ ", "cut at {cut}");
            assert_eq!(codes, vec![130], "cut at {cut}");
        }
    }

    #[test]
    fn byte_by_byte() {
        let full: &[u8] = b"a__KEMUDI_EXIT:2\nb";
        let chunks: Vec<&[u8]> = full.chunks(1).collect();
        let (data, codes) = run(&chunks);
        assert_eq!(data, b"ab");
        assert_eq!(codes, vec![2]);
    }

    #[test]
    fn lookalikes_pass_through() {
        for input in [
            &b"__KEMUDI_EXIT:abc\r\n"[..],
            b"__KEMUDI_EXIT:\r\n",
            b"__KEMUDI_EXIT:12x\r\n",
            b"__KEMUDI_EXIT:12345\r\n",
            b"__KEMUDI_EXI",
            b"snake_case_name_",
        ] {
            let (data, codes) = run(&[input]);
            assert_eq!(data, input, "{:?}", String::from_utf8_lossy(input));
            assert!(codes.is_empty());
        }
    }

    #[test]
    fn only_first_marker_counts() {
        let (data, codes) = run(&[b"__KEMUDI_EXIT:1\n", b"__KEMUDI_EXIT:2\n"]);
        assert_eq!(codes, vec![1]);
        assert_eq!(data, b"__KEMUDI_EXIT:2\n");
    }

    #[test]
    fn trailing_underscore_held_then_released() {
        let mut s = MarkerScanner::new();
        assert_eq!(s.feed(b"name_"), vec![Segment::Data(b"name".to_vec())]);
        assert_eq!(s.feed(b"x"), vec![Segment::Data(b"_x".to_vec())]);
    }

    #[test]
    fn suffix_prefix() {
        assert_eq!(suffix_prefix_len(b"abc__KEM", MARKER), 5);
        assert_eq!(suffix_prefix_len(b"abc", MARKER), 0);
        assert_eq!(suffix_prefix_len(b"_", MARKER), 1);
        assert_eq!(suffix_prefix_len(b"", MARKER), 0);
    }
}
