  document.addEventListener("DOMContentLoaded", () => {
    const hamburger = document.getElementById("hamburger");
    const drawer = document.getElementById("drawer");

    // Backdrop del drawer móvil
    const backdrop = document.createElement("div");
    backdrop.classList.add("drawer-backdrop");
    document.body.appendChild(backdrop);

    function abrirMenu() {
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      drawer.inert = false;
      backdrop.classList.add("active");
      hamburger.classList.add("active");
      hamburger.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
    }

    function cerrarMenu() {
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      drawer.inert = true;
      backdrop.classList.remove("active");
      hamburger.classList.remove("active");
      hamburger.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    }

    hamburger.addEventListener("click", () => {
      drawer.classList.contains("open") ? cerrarMenu() : abrirMenu();
    });
    backdrop.addEventListener("click", cerrarMenu);

    // Cerrar menú al hacer clic en un enlace del drawer
    drawer.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", cerrarMenu);
    });

    // Acordeón del drawer móvil
    drawer.querySelectorAll(".m-acc").forEach(btn => {
      btn.addEventListener("click", () => {
        const panel = btn.nextElementSibling;
        const isOpen = btn.classList.contains("open");

        drawer.querySelectorAll(".m-acc").forEach(b => {
          b.classList.remove("open");
          b.nextElementSibling.classList.remove("open");
        });

        if (!isOpen) {
          btn.classList.add("open");
          panel.classList.add("open");
        }
      });
    });

    // Dropdowns del navbar de escritorio (clic, además del hover en CSS)
    document.querySelectorAll(".nav-dropdown").forEach(dd => {
      const btn = dd.querySelector(".nav-btn");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = dd.classList.contains("open");
        document.querySelectorAll(".nav-dropdown").forEach(o => {
          o.classList.remove("open");
          o.querySelector(".nav-btn").setAttribute("aria-expanded", "false");
        });
        if (!isOpen) {
          dd.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        }
      });
    });

    document.addEventListener("click", () => {
      document.querySelectorAll(".nav-dropdown").forEach(o => {
        o.classList.remove("open");
        o.querySelector(".nav-btn").setAttribute("aria-expanded", "false");
      });
    });
  });
