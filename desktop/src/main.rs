//! Dotrino Modelos — la ventana del gestor de modelos.
//!
//! Igual que la ventana de la bóveda: esta app no sabe nada del gestor. Lanza el puente
//! (`dotrino-models bridge`) y le habla por sus tuberías, una línea JSON por mensaje (ver
//! `src/bridge.js`). El puente le manda el estado entero cada vez que cambia y recibe las
//! órdenes (instalar, encender, apagar, borrar, elegir modelo para una tarea).
//!
//! - Sin puertos: el canal son las tuberías del hijo, y el puente habla con el gestor por su
//!   socket privado.
//! - Cerrar la ventana no apaga el gestor: lo usan también las demás apps.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;

use dotrino_theme::{BODY, BOLD, BRAND, Pal, card, chip, danger_outline, fonts, ghost, primary, tab};
use iced::widget::{button, column, container, image, progress_bar, row, scrollable, space, text};
use iced::{Element, Length, Subscription, Task, Theme, theme, window};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const ICON_PNG: &[u8] = include_bytes!("../assets/icon-512.png");
const TASKS: [&str; 3] = ["transcribe", "translate", "chat"];

fn main() -> iced::Result {
    let icon = window::icon::from_file_data(ICON_PNG, None).ok();
    iced::application(App::boot, App::update, App::view)
        .title(|_: &App| "Dotrino Modelos".to_string())
        .subscription(App::subscription)
        .theme(App::theme)
        .font(fonts::QUICKSAND)
        .font(fonts::QUICKSAND_BOLD)
        .font(fonts::COMFORTAA)
        .default_font(BODY)
        .window(window::Settings {
            size: iced::Size::new(860.0, 680.0),
            min_size: Some(iced::Size::new(520.0, 420.0)),
            icon,
            ..Default::default()
        })
        .run()
}

// ------------------------------- el modelo ----------------------------------

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
struct Tested {
    es: String,
    en: String,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
struct Progress {
    phase: String,
    done: f64,
    total: f64,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
struct Model {
    id: String,
    name: String,
    tasks: Vec<String>,
    size: f64,
    #[serde(rename = "vramMB")]
    vram_mb: f64,
    languages: String,
    tested: Tested,
    state: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    progress: Option<Progress>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
struct Declaration {
    version: String,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
struct Status {
    daemon: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    v: Option<Declaration>,
    #[serde(default)]
    tasks: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    models: Vec<Model>,
}

#[derive(Debug, Deserialize)]
struct Wire {
    t: String,
    #[serde(default)]
    v: Option<Status>,
    #[serde(default)]
    msg: Option<String>,
}

#[derive(Debug, Clone)]
enum Bridge {
    Ready(mpsc::UnboundedSender<String>),
    Status(Box<Status>),
    Error(String),
    Failed(String),
}

#[derive(Debug, Clone)]
enum Message {
    Bridge(Bridge),
    Op(String),
    Mode(theme::Mode),
    Dismiss,
    Open(&'static str),
}

struct App {
    status: Option<Status>,
    tx: Option<mpsc::UnboundedSender<String>>,
    failed: Option<String>,
    error: Option<String>,
    mode: theme::Mode,
    es: bool,
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let app = App {
            status: None,
            tx: None,
            failed: None,
            error: None,
            mode: theme::Mode::Light,
            es: dotrino_theme::system_is_spanish(),
        };
        (app, iced::system::theme().map(Message::Mode))
    }

    fn theme(&self) -> Theme {
        dotrino_theme::theme(self.mode)
    }

    fn t(&self, es: &'static str, en: &'static str) -> &'static str {
        if self.es { es } else { en }
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            Subscription::run(bridge_stream).map(Message::Bridge),
            iced::system::theme_changes().map(Message::Mode),
        ])
    }

    fn update(&mut self, msg: Message) -> Task<Message> {
        match msg {
            Message::Bridge(Bridge::Ready(tx)) => self.tx = Some(tx),
            Message::Bridge(Bridge::Status(s)) => {
                self.failed = None;
                self.status = Some(*s);
            }
            Message::Bridge(Bridge::Error(e)) => self.error = Some(e),
            Message::Bridge(Bridge::Failed(e)) => self.failed = Some(e),
            Message::Op(json) => {
                self.error = None;
                if let Some(tx) = &self.tx {
                    let _ = tx.send(json);
                }
            }
            Message::Mode(m) => self.mode = m,
            Message::Dismiss => self.error = None,
            Message::Open(url) => {
                let _ = open::that(url);
            }
        }
        Task::none()
    }

    fn view(&self) -> Element<'_, Message> {
        let pal = Pal::of(self.mode);
        let mut col = column![self.top_bar(pal)].spacing(0);
        if let Some(e) = &self.error {
            col = col.push(self.banner(e, pal));
        }
        let body: Element<'_, Message> = if let Some(f) = &self.failed {
            self.bridge_failed(f, pal)
        } else {
            match &self.status {
                None => container(text(self.t("Conectando…", "Connecting…")).color(pal.text_dim)).padding(24).into(),
                Some(s) if !s.daemon => self.daemon_down(s, pal),
                Some(s) => self.main(s, pal),
            }
        };
        col = col.push(scrollable(container(body).padding([16, 20]).width(Length::Fill)).height(Length::Fill));
        container(col)
            .width(Length::Fill)
            .height(Length::Fill)
            .style(move |_| container::Style { background: Some(pal.bg.into()), ..Default::default() })
            .into()
    }

    fn top_bar(&self, pal: Pal) -> Element<'_, Message> {
        let logo = image(image::Handle::from_bytes(ICON_PNG)).width(28).height(28);
        let brand = text("Dotrino Modelos").font(BRAND).size(19).color(pal.accent);
        let (dot, label) = match &self.status {
            Some(s) if s.daemon => {
                let v = s.v.as_ref().map(|d| d.version.clone()).unwrap_or_default();
                (pal.ok, format!("{} {v} · {} {VERSION}", self.t("gestor", "manager"), self.t("ventana", "window")))
            }
            Some(_) => (pal.danger, format!("{} · {} {VERSION}", self.t("gestor detenido", "manager stopped"), self.t("ventana", "window"))),
            None => (pal.text_faint, format!("{} {VERSION}", self.t("ventana", "window"))),
        };
        let state = row![text("●").color(dot).size(12), text(label).size(13).color(pal.text_dim)]
            .spacing(6)
            .align_y(iced::Alignment::Center);
        container(
            row![logo, brand, space().width(Length::Fill), state]
                .spacing(10)
                .align_y(iced::Alignment::Center)
                .padding([10, 20]),
        )
        .width(Length::Fill)
        .style(move |_| container::Style { background: Some(pal.surface.into()), ..Default::default() })
        .into()
    }

    fn banner<'a>(&self, msg: &'a str, pal: Pal) -> Element<'a, Message> {
        container(
            row![
                text(msg).color(pal.danger).size(14).width(Length::Fill),
                button(text("✕").size(13)).padding([4, 10]).style(move |_, st| ghost(pal, st)).on_press(Message::Dismiss)
            ]
            .spacing(10)
            .align_y(iced::Alignment::Center),
        )
        .padding([8, 20])
        .width(Length::Fill)
        .style(move |_| container::Style { background: Some(pal.warn_soft.into()), ..Default::default() })
        .into()
    }

    fn bridge_failed<'a>(&self, err: &'a str, pal: Pal) -> Element<'a, Message> {
        column![
            text(self.t("No se encuentra dotrino-models.", "dotrino-models was not found.")).font(BOLD).size(16),
            text(err).size(13).color(pal.text_dim),
            button(text(self.t("Cómo instalarlo", "How to install it")).size(14))
                .padding([8, 16])
                .style(move |_, st| primary(pal, st))
                .on_press(Message::Open(install_url(self.es))),
        ]
        .spacing(10)
        .into()
    }

    fn daemon_down<'a>(&self, s: &'a Status, pal: Pal) -> Element<'a, Message> {
        let mut c = column![text(self.t("El gestor no está corriendo.", "The manager is not running.")).font(BOLD).size(16)].spacing(10);
        if let Some(e) = &s.error {
            c = c.push(text(e).size(13).color(pal.text_dim));
        }
        c.push(
            button(text(self.t("Arrancar", "Start")).size(14))
                .padding([8, 16])
                .style(move |_, st| primary(pal, st))
                .on_press(op("serve", None)),
        )
        .into()
    }

    fn main<'a>(&'a self, s: &'a Status, pal: Pal) -> Element<'a, Message> {
        let mut c = column![].spacing(10);
        c = c.push(section(self.t("Tareas", "Tasks"), pal));
        for t in TASKS {
            c = c.push(self.task_row(s, t, pal));
        }
        c = c.push(space().height(8));
        c = c.push(section(self.t("Catálogo", "Catalog"), pal));
        for m in &s.models {
            c = c.push(self.model_card(m, pal));
        }
        c.into()
    }

    fn task_label(&self, t: &str) -> &'static str {
        match t {
            "transcribe" => self.t("Voz a texto", "Speech to text"),
            "translate" => self.t("Traducir", "Translate"),
            "chat" => self.t("Conversar", "Chat"),
            _ => "?",
        }
    }

    /// Qué modelo atiende cada tarea. Solo se ofrecen los instalados que la hacen.
    fn task_row<'a>(&'a self, s: &'a Status, task: &'static str, pal: Pal) -> Element<'a, Message> {
        let chosen = s.tasks.get(task);
        let mut r = row![text(self.task_label(task)).font(BOLD).size(14).width(150)].spacing(8).align_y(iced::Alignment::Center);
        let usable: Vec<&Model> = s
            .models
            .iter()
            .filter(|m| m.tasks.iter().any(|x| x == task) && !matches!(m.state.as_str(), "absent" | "installing" | "unavailable"))
            .collect();
        if usable.is_empty() {
            r = r.push(text(self.t("Instala un modelo que la haga.", "Install a model that does it.")).size(13).color(pal.text_faint));
        }
        for m in usable {
            let active = chosen == Some(&m.id);
            let msg = serde_json::json!({ "op": "assign", "task": task, "id": m.id }).to_string();
            r = r.push(
                button(text(m.name.clone()).size(13).font(if active { BOLD } else { BODY }))
                    .padding([6, 12])
                    .style(move |_, st| tab(pal, active, st))
                    .on_press(Message::Op(msg)),
            );
        }
        container(r).padding([8, 14]).width(Length::Fill).style(move |_| card(pal, false)).into()
    }

    fn state_label(&self, state: &str) -> &'static str {
        match state {
            "absent" => self.t("sin instalar", "not installed"),
            "installing" => self.t("bajando", "downloading"),
            "stopped" => self.t("apagado", "stopped"),
            "starting" => self.t("encendiendo", "starting"),
            "running" => self.t("encendido", "running"),
            "stopping" => self.t("apagando", "stopping"),
            "failed" => self.t("falló", "failed"),
            "unavailable" => self.t("no disponible aquí", "not available here"),
            _ => "?",
        }
    }

    fn model_card<'a>(&'a self, m: &'a Model, pal: Pal) -> Element<'a, Message> {
        let (bg, fg) = match m.state.as_str() {
            "running" => (pal.accent_soft, pal.accent_soft_ink),
            "failed" | "unavailable" => (pal.warn_soft, pal.danger),
            _ => (pal.surface_2, pal.text_dim),
        };
        let mut head = row![text(m.name.clone()).font(BOLD).size(16)].spacing(8).align_y(iced::Alignment::Center);
        head = head.push(container(text(self.state_label(&m.state)).size(12)).padding([2, 10]).style(move |_| chip(bg, fg)));
        let facts = format!(
            "{} · {} · {} {} · {} {}",
            m.tasks.iter().map(|t| self.task_label(t)).collect::<Vec<_>>().join(", "),
            mb(m.size),
            self.t("video", "video"),
            mb(m.vram_mb * 1e6),
            self.t("idiomas:", "languages:"),
            m.languages
        );
        let tested = if self.es { m.tested.es.clone() } else { m.tested.en.clone() };
        let mut c = column![head, text(facts).size(13).color(pal.text_dim), text(tested).size(13).color(pal.text_faint)].spacing(6);

        if let Some(p) = &m.progress {
            let pct = if p.total > 0.0 { (p.done / p.total * 100.0) as f32 } else { 0.0 };
            let what = if p.phase == "engine" { self.t("motor", "engine") } else { self.t("modelo", "model") };
            c = c.push(progress_bar(0.0..=100.0, pct).girth(8));
            c = c.push(text(format!("{what}: {} / {}", mb(p.done), mb(p.total))).size(12).color(pal.text_dim));
        }
        if let Some(e) = &m.error {
            c = c.push(text(e.clone()).size(12).color(pal.danger));
        }

        let id = Some(m.id.as_str());
        let b = |label: &'static str, style: fn(Pal, button::Status) -> button::Style, msg: Option<Message>| {
            button(text(label).size(13)).padding([6, 14]).style(move |_, st| style(pal, st)).on_press_maybe(msg)
        };
        let actions: Element<'_, Message> = match m.state.as_str() {
            "absent" => row![b(self.t("Instalar", "Install"), primary, Some(op("install", id)))].into(),
            "installing" => row![b(self.t("Cancelar", "Cancel"), ghost, Some(op("cancel", id)))].into(),
            "stopped" => row![
                b(self.t("Encender", "Start"), primary, Some(op("start", id))),
                b(self.t("Borrar", "Delete"), danger_outline, Some(op("remove", id)))
            ]
            .spacing(8)
            .into(),
            "running" => row![b(self.t("Apagar", "Stop"), ghost, Some(op("stop", id)))].into(),
            "failed" => row![
                b(self.t("Reintentar", "Retry"), primary, Some(op("start", id))),
                b(self.t("Borrar", "Delete"), danger_outline, Some(op("remove", id)))
            ]
            .spacing(8)
            .into(),
            // Deshabilitado, no escondido: se ve que existe y por qué no se puede.
            _ => row![b(self.t("Instalar", "Install"), primary, None)].into(),
        };
        c = c.push(actions);
        container(c).padding([12, 14]).width(Length::Fill).style(move |_| card(pal, m.state == "running")).into()
    }
}

fn section(title: &'static str, pal: Pal) -> Element<'static, Message> {
    text(title).font(BOLD).size(15).color(pal.text_dim).into()
}

fn op(name: &str, id: Option<&str>) -> Message {
    let v = match id {
        Some(id) => serde_json::json!({ "op": name, "id": id }),
        None => serde_json::json!({ "op": name }),
    };
    Message::Op(v.to_string())
}

fn mb(bytes: f64) -> String {
    if bytes >= 1e9 { format!("{:.1} GB", bytes / 1e9) } else { format!("{:.0} MB", bytes / 1e6) }
}

fn install_url(es: bool) -> &'static str {
    if es { "https://wiki.dotrino.com/herramientas/modelos/" } else { "https://wiki.dotrino.com/en/herramientas/modelos/" }
}

// ------------------------------- el puente ----------------------------------

/// El programa del puente: `DOTRINO_MODELS_BIN` si está (desarrollo), si no `dotrino-models`
/// del PATH. Si no está, se dice: no hay otro sitio donde buscarlo.
fn bridge_command() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("DOTRINO_MODELS_BIN") {
        return Ok(PathBuf::from(p));
    }
    let name = if cfg!(windows) { "dotrino-models.cmd" } else { "dotrino-models" };
    let path = std::env::var_os("PATH").ok_or("PATH is not set")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| format!("{name} is not in the PATH (npm i -g @dotrino/models)"))
}

fn bridge_stream() -> impl iced::futures::Stream<Item = Bridge> {
    iced::stream::channel(64, async |mut out: iced::futures::channel::mpsc::Sender<Bridge>| {
        use iced::futures::SinkExt;
        let prog = match bridge_command() {
            Ok(p) => p,
            Err(e) => {
                let _ = out.send(Bridge::Failed(e)).await;
                return std::future::pending::<()>().await;
            }
        };
        let mut child = match tokio::process::Command::new(&prog)
            .arg("bridge")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = out.send(Bridge::Failed(format!("{}: {e}", prog.display()))).await;
                return std::future::pending::<()>().await;
            }
        };
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let _ = out.send(Bridge::Ready(tx)).await;
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(w) = serde_json::from_str::<Wire>(&line) else { continue };
            match (w.t.as_str(), w.v, w.msg) {
                ("status", Some(s), _) => {
                    let _ = out.send(Bridge::Status(Box::new(s))).await;
                }
                ("error", _, Some(m)) => {
                    let _ = out.send(Bridge::Error(m)).await;
                }
                _ => {}
            }
        }
        let why = match child.wait().await {
            Ok(s) => format!("the bridge exited ({s})"),
            Err(e) => format!("the bridge failed: {e}"),
        };
        let _ = out.send(Bridge::Failed(why)).await;
        std::future::pending::<()>().await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_estado_del_puente_se_lee() {
        let line = r#"{"t":"status","v":{"daemon":true,"bridgeVersion":"0.1.0","v":{"product":"models","version":"0.1.0","protocol":1,"speaks":[1]},"tasks":{"transcribe":"w"},"models":[{"id":"w","name":"W","tasks":["transcribe"],"engine":"whisper.cpp","size":574041195,"vramMB":900,"languages":"99","tested":{"es":"a","en":"b"},"local":true,"state":"installing","progress":{"phase":"model","done":10,"total":20}}]}}"#;
        let w: Wire = serde_json::from_str(line).unwrap();
        let s = w.v.unwrap();
        assert!(s.daemon);
        assert_eq!(s.tasks.get("transcribe").unwrap(), "w");
        assert_eq!(s.models[0].progress.as_ref().unwrap().total, 20.0);
    }

    #[test]
    fn el_gestor_caido_se_lee() {
        let line = r#"{"t":"status","v":{"daemon":false,"code":"not-running","error":"dotrino-models is not running"}}"#;
        let w: Wire = serde_json::from_str(line).unwrap();
        assert!(!w.v.unwrap().daemon);
    }

    #[test]
    fn tamanos() {
        assert_eq!(mb(574_041_195.0), "574 MB");
        assert_eq!(mb(2_497_281_120.0), "2.5 GB");
    }
}
