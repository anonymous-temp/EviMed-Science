import { GenomeView } from "@/components/inspector/GenomeView";
import { MoleculeView } from "@/components/inspector/MoleculeView";
import { FitsView } from "@/components/inspector/FitsView";
import { AnomalyMapView } from "@/components/inspector/AnomalyMapView";
import { MeshView } from "@/components/inspector/MeshView";
import { FITS_IMAGE_2D_B64 } from "@/lib/fits.fixtures";

const bed = "chr1\t0\t100\tSynthetic_gene_A\t500\t+\nchr1\t150\t260\tSynthetic_gene_B\t0\t-\nchr2\t0\t50\tSynthetic_gene_C";
const xyz = "3\nSynthetic water\nO 0 0 0\nH 0.95 0 0\nH -0.24 0.92 0";
const anomaly = "lat,lon,anomaly\n-45,-90,-2\n-45,90,1\n45,-90,0.5\n45,90,2.5";
const fits = Uint8Array.from(atob(FITS_IMAGE_2D_B64), (c) => c.charCodeAt(0)).buffer;
const mesh = new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3").buffer;

/** Synthetic, locally decoded scientific files; no patient or research data. */
export function ScientificViewerGallery() {
  return <div className="space-y-6">{[
    ["BED", <GenomeView filename="synthetic.bed" text={bed} />],
    ["XYZ", <MoleculeView filename="synthetic.xyz" text={xyz} />],
    ["FITS", <FitsView filename="synthetic.fits" bytes={fits} />],
    ["Anomaly", <AnomalyMapView filename="synthetic.anom" text={anomaly} />],
    ["Mesh", <MeshView filename="synthetic.obj" bytes={mesh} />],
  ].map(([name, viewer]) => <section key={String(name)}><h2>{name}</h2><div className="h-[480px] min-w-0 border border-border">{viewer}</div></section>)}</div>;
}
