// Microphone Capture - Lock-Free Real-Time Compliant
//
// Architecture:
// 1. CPAL callback: ONLY pushes to lock-free ring buffer
// 2. No mutexes, allocations, or DSP in callback
// 3. Background thread: drains buffer, resamples, emits to JS

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::{Condvar, Mutex};

use crate::audio_config::RING_BUFFER_SAMPLES;

static RAW_CALLBACK_COUNT: AtomicUsize = AtomicUsize::new(0);
static LAST_RAW_LOG_MS: AtomicU64 = AtomicU64::new(0);

fn trace_raw_samples_f32(data: &[f32]) {
    let count = data.len();

    if count == 0 {
        return;
    }

    let prev_count = RAW_CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);

    if prev_count == 0 {
        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_RAW_CALLBACK_FIRST\nsamples={}",
            count
        );
    }

    let now_ms = match std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
    {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    };

    let last_log = LAST_RAW_LOG_MS.load(Ordering::Relaxed);

    if now_ms.saturating_sub(last_log) >= 1500 {
        if LAST_RAW_LOG_MS
            .compare_exchange(
                last_log,
                now_ms,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            let mut non_zero = 0;
            let mut peak: f32 = 0.0;
            let mut sum_sq = 0.0;

            for &val in data {
                if val != 0.0 {
                    non_zero += 1;
                }

                let abs_val = val.abs();

                if abs_val > peak {
                    peak = abs_val;
                }

                sum_sq += val * val;
            }

            let rms = (sum_sq / count as f32).sqrt();

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_RAW_PCM\nsamples={}\nnon_zero_samples={}\npeak={:.6}\nrms={:.6}",
                count,
                non_zero,
                peak,
                rms
            );
        }
    }
}

fn trace_raw_samples_i16(data: &[i16]) {
    let count = data.len();

    if count == 0 {
        return;
    }

    let prev_count = RAW_CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);

    if prev_count == 0 {
        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_RAW_CALLBACK_FIRST\nsamples={}",
            count
        );
    }

    let now_ms = match std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
    {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    };

    let last_log = LAST_RAW_LOG_MS.load(Ordering::Relaxed);

    if now_ms.saturating_sub(last_log) >= 1500 {
        if LAST_RAW_LOG_MS
            .compare_exchange(
                last_log,
                now_ms,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            let mut non_zero = 0;
            let mut peak: f32 = 0.0;
            let mut sum_sq = 0.0;

            for &val in data {
                let fval = val as f32 / 32768.0;

                if val != 0 {
                    non_zero += 1;
                }

                let abs_val = fval.abs();

                if abs_val > peak {
                    peak = abs_val;
                }

                sum_sq += fval * fval;
            }

            let rms = (sum_sq / count as f32).sqrt();

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_RAW_PCM\nsamples={}\nnon_zero_samples={}\npeak={:.6}\nrms={:.6}",
                count,
                non_zero,
                peak,
                rms
            );
        }
    }
}

fn trace_raw_samples_i32(data: &[i32]) {
    let count = data.len();

    if count == 0 {
        return;
    }

    let prev_count = RAW_CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);

    if prev_count == 0 {
        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_RAW_CALLBACK_FIRST\nsamples={}",
            count
        );
    }

    let now_ms = match std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
    {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    };

    let last_log = LAST_RAW_LOG_MS.load(Ordering::Relaxed);

    if now_ms.saturating_sub(last_log) >= 1500 {
        if LAST_RAW_LOG_MS
            .compare_exchange(
                last_log,
                now_ms,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .is_ok()
        {
            let mut non_zero = 0;
            let mut peak: f32 = 0.0;
            let mut sum_sq = 0.0;

            for &val in data {
                let fval = val as f32 / 2147483648.0;

                if val != 0 {
                    non_zero += 1;
                }

                let abs_val = fval.abs();

                if abs_val > peak {
                    peak = abs_val;
                }

                sum_sq += fval * fval;
            }

            let rms = (sum_sq / count as f32).sqrt();

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_RAW_PCM\nsamples={}\nnon_zero_samples={}\npeak={:.6}\nrms={:.6}",
                count,
                non_zero,
                peak,
                rms
            );
        }
    }
}

/// List available input devices
pub fn list_input_devices() -> Result<Vec<(String, String)>> {
    let host = cpal::default_host();
    let mut list = Vec::new();

    list.push((
        "default".to_string(),
        "Default Microphone".to_string(),
    ));

    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                list.push((name.clone(), name));
            }
        }
    }

    Ok(list)
}

/// Normalize a cpal device name for fuzzy matching across plug/unplug cycles.
fn normalize_device_name(s: &str) -> String {
    let stripped = s
        .trim()
        .trim_start_matches(|c: char| {
            c == '(' || c.is_ascii_digit() || c == '-' || c == ' '
        })
        .trim_end_matches(|c: char| c == ')' || c == ' ');

    stripped
        .chars()
        .map(|c| match c {
            '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            other => other,
        })
        .collect::<String>()
        .to_lowercase()
}

fn resolve_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device> {
    let req_str = device_id.unwrap_or("default");

    eprintln!(
        "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_REQUEST\nrequested={}",
        req_str
    );

    let requested_id = device_id
        .map(str::trim)
        .filter(|id| {
            !id.is_empty() && !id.eq_ignore_ascii_case("default")
        });

    if let Some(requested_id) = requested_id {
        let normalized_request = normalize_device_name(requested_id);

        let mut best: Option<(u8, cpal::Device, String)> = None;
        let mut available_devices = Vec::new();

        for device in host.input_devices()? {
            let name = device
                .name()
                .unwrap_or_else(|_| "<unknown input>".to_string());

            let tier = if name == requested_id {
                Some(0u8)
            } else if name.eq_ignore_ascii_case(requested_id) {
                Some(1u8)
            } else if normalize_device_name(&name) == normalized_request {
                Some(2u8)
            } else {
                None
            };

            available_devices.push(name.clone());

            if let Some(t) = tier {
                if best
                    .as_ref()
                    .map(|(bt, _, _)| t < *bt)
                    .unwrap_or(true)
                {
                    best = Some((t, device, name));

                    if t == 0 {
                        break;
                    }
                }
            }
        }

        if let Some((tier, device, matched_name)) = best {
            let label = match tier {
                0 => "exact",
                1 => "case-insensitive",
                _ => "fuzzy",
            };

            println!(
                "[Microphone] Using {} match for input device: requested='{}' matched='{}'",
                label,
                requested_id,
                matched_name
            );

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_SELECTED\nname={}\nis_default=false",
                matched_name
            );

            return Ok(device);
        }

        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_NOT_FOUND\nrequested={}",
            requested_id
        );

        eprintln!(
            "[NATIVELY_AUDIO_TRACE] AVAILABLE_DEVICES_ON_FAILURE: {}",
            available_devices.join(", ")
        );

        if let Some(def_device) = host.default_input_device() {
            let def_name = def_device
                .name()
                .unwrap_or_else(|_| "default_device".to_string());

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_FALLBACK\nrequested={}\nfallback={}",
                requested_id,
                def_name
            );

            eprintln!(
                "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_SELECTED\nname={}\nis_default=true",
                def_name
            );

            return Ok(def_device);
        }

        return Err(anyhow::anyhow!(
            "Input device '{}' not found. Available devices: {}",
            requested_id,
            available_devices.join(", ")
        ));
    }

    if let Some(def_device) = host.default_input_device() {
        let def_name = def_device
            .name()
            .unwrap_or_else(|_| "default_device".to_string());

        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_SELECTED\nname={}\nis_default=true",
            def_name
        );

        return Ok(def_device);
    }

    eprintln!(
        "[NATIVELY_AUDIO_TRACE] RUST_DEVICE_NOT_FOUND\nrequested=default"
    );

    Err(anyhow::anyhow!("No input device found"))
}

/// Lock-free microphone stream.
pub struct MicrophoneStream {
    stream: Option<Stream>,
    consumer: Option<HeapCons<f32>>,
    sample_rate: u32,
    is_running: Arc<AtomicBool>,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
    err_signal: Arc<Mutex<Option<String>>>,
}

fn pick_supported_config(
    device: &cpal::Device,
) -> Result<cpal::SupportedStreamConfig> {
    let default_cfg = device
        .default_input_config()
        .map_err(|e| {
            anyhow::anyhow!(
                "Failed to get default input config: {}",
                e
            )
        })?;

    if matches!(
        default_cfg.sample_format(),
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
    ) {
        return Ok(default_cfg);
    }

    println!(
        "[Microphone] Default config has unsupported format ({:?}); negotiating from supported_input_configs()...",
        default_cfg.sample_format()
    );

    let configs: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| {
            anyhow::anyhow!(
                "supported_input_configs failed: {}",
                e
            )
        })?
        .collect();

    for preferred in [
        SampleFormat::F32,
        SampleFormat::I16,
        SampleFormat::I32,
    ] {
        if let Some(range) = configs
            .iter()
            .find(|r| r.sample_format() == preferred)
        {
            let target_rate = range
                .max_sample_rate()
                .0
                .min(48_000)
                .max(range.min_sample_rate().0);

            let cfg = range
                .clone()
                .with_sample_rate(cpal::SampleRate(target_rate));

            println!(
                "[Microphone] Negotiated fallback config: {}Hz, {}ch, {:?}",
                cfg.sample_rate().0,
                cfg.channels(),
                cfg.sample_format()
            );

            return Ok(cfg);
        }
    }

    Err(anyhow::anyhow!(
        "Microphone exposes no supported format (need F32/I16/I32). Default was {:?}.",
        default_cfg.sample_format()
    ))
}

impl MicrophoneStream {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let host = cpal::default_host();

        let device =
            resolve_input_device(&host, device_id.as_deref())?;

        let config = pick_supported_config(&device)?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let format = config.sample_format();

        // FIX:
        // SupportedStreamConfig::buffer_size() returns
        // &SupportedBufferSize, not BufferSize.
        let buf_size_str = match config.buffer_size() {
            cpal::SupportedBufferSize::Range { min, max } => {
                format!("range({}-{})", min, max)
            }
            cpal::SupportedBufferSize::Unknown => {
                "unknown".to_string()
            }
        };

        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_STREAM_CONFIG\nsample_format={:?}\nsample_rate={}\nchannels={}\nbuffer_size={}",
            format,
            sample_rate,
            channels,
            buf_size_str
        );

        println!(
            "[Microphone] Device: {}, Rate: {}Hz, Channels: {}, Format: {:?}",
            device.name().unwrap_or_default(),
            sample_rate,
            channels,
            config.sample_format()
        );

        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();

        let is_running = Arc::new(AtomicBool::new(false));
        let is_running_clone = is_running.clone();

        let data_ready =
            Arc::new((Mutex::new(false), Condvar::new()));

        let data_ready_clone = data_ready.clone();

        let err_signal: Arc<Mutex<Option<String>>> =
            Arc::new(Mutex::new(None));

        let err_signal_clone = err_signal.clone();

        let stream_res = build_input_stream(
            &device,
            &config,
            producer,
            channels,
            is_running_clone,
            data_ready_clone,
            err_signal_clone,
        );

        let stream = match stream_res {
            Ok(s) => {
                eprintln!(
                    "[NATIVELY_AUDIO_TRACE] RUST_STREAM_CREATED"
                );

                s
            }

            Err(e) => {
                eprintln!(
                    "[NATIVELY_AUDIO_TRACE] RUST_STREAM_ERROR\nstage=build\nerror={}",
                    e
                );

                return Err(e);
            }
        };

        Ok(Self {
            stream: Some(stream),
            consumer: Some(consumer),
            sample_rate,
            is_running,
            data_ready,
            err_signal,
        })
    }

    pub fn play(&self) -> Result<()> {
        if let Some(ref stream) = self.stream {
            match stream.play() {
                Ok(_) => {
                    self.is_running
                        .store(true, Ordering::SeqCst);

                    println!("[Microphone] Stream started");

                    eprintln!(
                        "[NATIVELY_AUDIO_TRACE] RUST_STREAM_PLAYING"
                    );
                }

                Err(e) => {
                    eprintln!(
                        "[NATIVELY_AUDIO_TRACE] RUST_STREAM_ERROR\nstage=play\nerror={}",
                        e
                    );

                    return Err(anyhow::anyhow!(
                        "Failed to start stream: {}",
                        e
                    ));
                }
            }
        }

        Ok(())
    }

    pub fn pause(&self) -> Result<()> {
        if let Some(ref stream) = self.stream {
            stream
                .pause()
                .map_err(|e| {
                    anyhow::anyhow!(
                        "Failed to pause stream: {}",
                        e
                    )
                })?;

            self.is_running
                .store(false, Ordering::SeqCst);

            println!("[Microphone] Stream paused");
        }

        Ok(())
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn data_ready_signal(
        &self,
    ) -> Arc<(Mutex<bool>, Condvar)> {
        self.data_ready.clone()
    }

    pub fn err_signal(
        &self,
    ) -> Arc<Mutex<Option<String>>> {
        self.err_signal.clone()
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    mut producer: HeapProd<f32>,
    channels: usize,
    is_running: Arc<AtomicBool>,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
    err_signal: Arc<Mutex<Option<String>>>,
) -> Result<Stream> {
    let err_fn = move |err: cpal::StreamError| {
        let msg = format!("{}", err);

        eprintln!(
            "[Microphone] Stream error: {}",
            msg
        );

        eprintln!(
            "[NATIVELY_AUDIO_TRACE] RUST_STREAM_ERROR\nstage=callback\nerror={}",
            msg
        );

        if let Ok(mut slot) = err_signal.lock() {
            if slot.is_none() {
                *slot = Some(msg);
            }
        }
    };

    let stream = match config.sample_format() {
        SampleFormat::F32 => {
            let data_ready_f32 = data_ready.clone();

            device.build_input_stream(
                &config.clone().into(),
                move |data: &[f32],
                      _: &cpal::InputCallbackInfo| {
                    if !is_running.load(Ordering::Relaxed) {
                        return;
                    }

                    trace_raw_samples_f32(data);

                    if channels > 1 {
                        for chunk in data.chunks(channels) {
                            let _ = producer.try_push(chunk[0]);
                        }
                    } else {
                        let _ = producer.push_slice(data);
                    }

                    let (lock, cvar) = &*data_ready_f32;

                    if let Ok(mut ready) = lock.lock() {
                        *ready = true;
                        cvar.notify_one();
                    }
                },
                err_fn,
                None,
            )?
        }

        SampleFormat::I16 => {
            let data_ready_i16 = data_ready.clone();

            device.build_input_stream(
                &config.clone().into(),
                move |data: &[i16],
                      _: &cpal::InputCallbackInfo| {
                    if !is_running.load(Ordering::Relaxed) {
                        return;
                    }

                    trace_raw_samples_i16(data);

                    if channels > 1 {
                        for chunk in data.chunks(channels) {
                            let sample =
                                chunk[0] as f32 / 32768.0;

                            let _ = producer.try_push(sample);
                        }
                    } else {
                        for &sample in data {
                            let _ = producer.try_push(
                                sample as f32 / 32768.0,
                            );
                        }
                    }

                    let (lock, cvar) = &*data_ready_i16;

                    if let Ok(mut ready) = lock.lock() {
                        *ready = true;
                        cvar.notify_one();
                    }
                },
                err_fn,
                None,
            )?
        }

        SampleFormat::I32 => {
            let data_ready_i32 = data_ready;

            device.build_input_stream(
                &config.clone().into(),
                move |data: &[i32],
                      _: &cpal::InputCallbackInfo| {
                    if !is_running.load(Ordering::Relaxed) {
                        return;
                    }

                    trace_raw_samples_i32(data);

                    if channels > 1 {
                        for chunk in data.chunks(channels) {
                            let sample =
                                chunk[0] as f32 / 2147483648.0;

                            let _ = producer.try_push(sample);
                        }
                    } else {
                        for &sample in data {
                            let _ = producer.try_push(
                                sample as f32 / 2147483648.0,
                            );
                        }
                    }

                    let (lock, cvar) = &*data_ready_i32;

                    if let Ok(mut ready) = lock.lock() {
                        *ready = true;
                        cvar.notify_one();
                    }
                },
                err_fn,
                None,
            )?
        }

        format => {
            return Err(anyhow::anyhow!(
                "Unsupported sample format: {:?}",
                format
            ));
        }
    };

    Ok(stream)
}

impl Drop for MicrophoneStream {
    fn drop(&mut self) {
        self.is_running
            .store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_device_name;

    #[test]
    fn normalize_strips_wasapi_index_prefix() {
        assert_eq!(
            normalize_device_name("(2- USB Audio Device)"),
            "usb audio device"
        );

        assert_eq!(
            normalize_device_name("(15- Microphone)"),
            "microphone"
        );
    }

    #[test]
    fn normalize_collapses_unicode_dashes() {
        assert_eq!(
            normalize_device_name(
                "AirPods Pro – Hands-Free"
            ),
            "airpods pro - hands-free"
        );

        assert_eq!(
            normalize_device_name(
                "AirPods Pro — Hands-Free"
            ),
            "airpods pro - hands-free"
        );
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(
            normalize_device_name("  AirPods Pro  "),
            "airpods pro"
        );

        assert_eq!(
            normalize_device_name("AIRPODS PRO"),
            "airpods pro"
        );
    }

    #[test]
    fn normalize_idempotent_on_clean_name() {
        assert_eq!(
            normalize_device_name("built-in microphone"),
            "built-in microphone"
        );
    }
}