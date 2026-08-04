use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use base64::{engine::general_purpose, Engine as _};

#[derive(Serialize, Clone)]
struct PhotoEntry {
    path: String,
    name: String,
}

const RAW_HEIC_EXT: &[&str] = &[
    "heic", "heif", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf",
];
const STANDARD_EXT: &[&str] = &["jpg", "jpeg", "png", "tiff", "tif", "bmp"];

// 1. List semua foto di folder yang dipilih
#[tauri::command]
fn list_photos(folder: String) -> Result<Vec<PhotoEntry>, String> {
    let mut entries: Vec<PhotoEntry> = Vec::new();
    let dir = Path::new(&folder);

    if !dir.is_dir() {
        return Err("Folder tidak valid".into());
    }

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if STANDARD_EXT.contains(&ext_lower.as_str())
                    || RAW_HEIC_EXT.contains(&ext_lower.as_str())
                {
                    entries.push(PhotoEntry {
                        path: path.to_string_lossy().to_string(),
                        name: path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                    });
                }
            }
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

// 2. Generate preview base64 JPG dari foto apapun (pakai `sips`, native macOS)
//    Untuk JPG/PNG kecil, langsung baca saja tanpa convert supaya cepat.
#[tauri::command]
fn get_preview(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if STANDARD_EXT.contains(&ext.as_str()) {
        // Baca langsung, encode base64
        let bytes = fs::read(p).map_err(|e| e.to_string())?;
        let b64 = general_purpose::STANDARD.encode(bytes);
        let mime = if ext == "png" { "image/png" } else { "image/jpeg" };
        return Ok(format!("data:{};base64,{}", mime, b64));
    }

    // Untuk HEIC/RAW -> convert ke JPG sementara pakai `sips`
    let tmp_dir = std::env::temp_dir().join("photo-culler-preview");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let file_stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("preview");
    let out_path = tmp_dir.join(format!("{}.jpg", file_stem));

    let output = Command::new("sips")
        .args([
            "-s",
            "format",
            "jpeg",
            path.as_str(),
            "--out",
            out_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("Gagal menjalankan sips: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "sips gagal convert: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let bytes = fs::read(&out_path).map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

// 3. Pindahkan (move) foto yang dipilih ke folder tujuan
#[tauri::command]
fn move_photo(source: String, dest_folder: String) -> Result<String, String> {
    let src = Path::new(&source);
    let dest_dir = Path::new(&dest_folder);

    if !dest_dir.exists() {
        fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    }

    let file_name = src
        .file_name()
        .ok_or_else(|| "Nama file tidak valid".to_string())?;
    let dest_path = dest_dir.join(file_name);

    // Kalau nama sudah ada, jangan overwrite -> tambahkan suffix
    let final_dest = if dest_path.exists() {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        let mut counter = 1;
        loop {
            let candidate = dest_dir.join(format!("{}_{}.{}", stem, counter, ext));
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        }
    } else {
        dest_path
    };

    fs::rename(src, &final_dest).map_err(|e| e.to_string())?;
    Ok(final_dest.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_photos,
            get_preview,
            move_photo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
