// Reading copies preserve the source presentations and their download links.
window.LessonCompanions = (() => {
  const course = "c_ce795f91-5ff0-4270-9cc2-d7ef4f930933";
  const copies = {
    "l_d955207e-49b1-4957-8433-f069ae4f67dd": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/04435b4f-13dc-4543-b5f0-e73afec237f7-01-las-sagradas-escrituras.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-01.pdf"
    },
    "l_b27023a5-7b37-4636-bf38-ae22e6ea76de": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/5332a8b8-c301-438c-b29e-c88738be66aa-02-dios.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-02.pdf"
    },
    "l_90e716bd-20ca-40ad-b0fe-f120854fb63b": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/f88a865e-4e20-436d-b914-7c64949e76cf-03-la-trinidad.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-03.pdf"
    },
    "l_19ea7ca1-7650-4610-9dcc-bf97f773647f": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/0c54fb4e-348f-454c-bf80-beafa23f7cf3-04-la-oracion.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-04.pdf"
    },
    "l_818813aa-4da9-4f27-a476-b3312f8c9674": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/3f4592a2-ee6c-4f1f-b195-4be15bcaf24d-05-la-fe.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-05.pdf"
    },
    "l_257d314d-5189-4ab5-bcd2-500dc2ff7f71": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/fa49f425-2cea-4a05-8fb5-84416c339ccc-06-la-segunda-venida-de-jesus.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-06.pdf"
    },
    "l_54ea3fbe-2073-4de1-98c4-41a2d00ed450": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/c968bc68-95ed-408e-a8ee-ae978623f261-07-las-senales-del-regreso-de-jesus.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-07.pdf"
    },
    "l_ad8cb67a-9359-408c-9937-d3057184ee96": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/6accb91b-dc89-4c8d-a20d-72a74e6ccf9d-08-el-origen-del-mal.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-08.pdf"
    },
    "l_8810a4a9-1c9e-4906-a968-d87f4d60d719": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/da323a4b-be98-4402-8057-6b52726bde28-09-la-salvacion.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-09.pdf"
    },
    "l_4afbc1ef-6918-4194-be6b-be26d10728fe": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/252cba30-4e37-4877-9569-51000cde4ccb-10-el-perdon.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-10.pdf"
    },
    "l_1eaad846-631b-43b6-a32c-59f3fb91498e": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/8fc8a33d-22c4-47fe-abba-eaaa3f3c5975-11-el-juicio.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-11.pdf"
    },
    "l_a0f794d7-c774-477c-acbe-2ea60ce36405": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/6c23ffd7-aea1-4b9f-8af0-6031ead13b6a-12-la-ley-de-dios.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-12.pdf"
    },
    "l_54877d9e-e4b3-41d1-b762-b99eb4057bb6": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/b26a5f20-f400-4182-9228-53eb4811b2de-13-el-dia-de-descanso.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-13.pdf"
    },
    "l_f5138812-4165-432c-b82c-0068e21a368f": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/0071f23f-1236-44f8-9789-77fcc7fb0e54-14-la-observancia-del-sabado.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-14.pdf"
    },
    "l_626c1a31-baf3-4f47-95a3-b413c7abe0a0": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/5c4c25f2-10e4-4a3a-b73d-e4d26d8e75e8-15-la-muerte.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-15.pdf"
    },
    "l_78501070-cbe4-4c69-9b60-c3710cac7178": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/4d0ed258-0559-4cbf-9341-10e0e8f31ad9-16-la-iglesia.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-16.pdf"
    },
    "l_7f808d60-473e-442a-91a3-31a629a47c79": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/5d01e708-b237-439d-80ad-0820c26299a5-17-el-don-de-profecia.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-17.pdf"
    },
    "l_dc8936ab-42c2-4127-a2dd-c62f1739efae": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/58af3e88-cff7-43d2-a119-7626d9b34b0b-18-el-bautismo.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-18.pdf"
    },
    "l_b832c206-7390-46eb-8bfe-c030790d2974": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/6bda236f-7788-4629-8e1a-f90524d5dd0b-19-el-diezmo.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-19.pdf"
    },
    "l_5c71bda5-74da-4956-9466-f66fd453187d": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/a8cbf6cb-e4c9-49a6-8313-a2a33f4b80d6-20-las-ofrendas.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-20.pdf"
    },
    "l_389adf00-cfc7-44d5-b20e-9c58f6290530": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/16f29c7c-8163-44a3-8651-d53af1b6ea33-21-el-estilo-de-vida-cristiano.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-21.pdf"
    },
    "l_2cd39828-1777-43cc-8cab-5e372ee1e6ec": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/c9604be3-dc75-4da2-b8fb-1542bde10828-22-los-principios-de-salud.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-22.pdf"
    },
    "l_9f7819cf-4029-477c-853d-f02e4d74e12e": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/08be6331-0aba-480f-8492-ef3dd5862fb5-23-el-discipulado.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-23.pdf"
    },
    "l_05195e84-5171-48e1-bd22-ac5578f2b5da": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/20e0c9ed-1fe3-47bc-b922-aef0e2cc83cc-24-el-hogar-cristiano.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-24.pdf"
    },
    "l_c0846cb4-64e7-4f40-b3cc-8d208aeb2764": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/e85118f1-07fe-4bb6-afe4-17b1676bc934-25-las-luchas-del-cristiano.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-25.pdf"
    },
    "l_739d5f85-fee7-4985-aad1-7d5b0c06c73e": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/10a85ad7-e1ef-4e54-931b-d4c3bbc42545-26-los-miembros-de-iglesia.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-26.pdf"
    },
    "l_c5367604-2055-40b8-a9b5-99fe4636061a": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/51a1ab41-630e-4531-87d6-6a052c666865-27-el-futuro-revelado.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-27.pdf"
    },
    "l_57c295eb-2d3d-4d8e-b9a1-3cad73246400": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/7e8536e9-112c-4dfd-abd2-e66e0f111302-28-la-profecia-mas-extraordinaria.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-28.pdf"
    },
    "l_9f57406e-8c41-4bd9-a0a2-6cfa381e7ec1": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/d8c999bb-d978-445e-a941-54ebfd004e1b-29-el-milenio.pptx",
      "pdfUrl": "/assets/companions/el-milenio.pdf"
    },
    "l_e1dd5539-2e87-4c92-8698-189b33c80f6d": {
      "sourceUrl": "https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/3f36bc99-fe43-48a3-8a4a-d306a8acba4c-30-un-nuevo-mundo.pptx",
      "pdfUrl": "/assets/companions/fe-de-jesus-2-30.pdf"
    }
  };
  return {
    get(courseId, lesson) {
      if (courseId !== course) return null;
      const copy = copies[lesson?.id];
      if (!copy || String(lesson.url || lesson.downloadUrl || '').split('?')[0] !== copy.sourceUrl) return null;
      return { pdfUrl: copy.pdfUrl };
    }
  };
})();
