import { useEffect, useRef, useState } from "react";
import type {
  ContactCardSelection,
  CreateProductInput,
  ProductDetail,
  ProductReadiness,
  ProductSummary,
} from "../../../../shared/contracts.js";
import { emptyReadiness, initialInput } from "../../helpers";

const ACTIVE_PRODUCT_STORAGE_KEY = "vbk:activeLocalProductId";

function readInitialActiveLocalProductId(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PRODUCT_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch { return null; }
}

export function useProductState() {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [activeLocalProductId, setActiveLocalProductId] = useState<string | null>(readInitialActiveLocalProductId);
  const hasSyncedActiveProductRef = useRef(false);
  useEffect(() => {
    if (!hasSyncedActiveProductRef.current) {
      hasSyncedActiveProductRef.current = true;
      return;
    }
    const nextId = product?.id ?? null;
    try {
      if (nextId) localStorage.setItem(ACTIVE_PRODUCT_STORAGE_KEY, nextId);
      else localStorage.removeItem(ACTIVE_PRODUCT_STORAGE_KEY);
    } catch { /* 忽略 */ }
    setActiveLocalProductId(nextId);
  }, [product?.id]);

  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [readiness, setReadiness] = useState<ProductReadiness>(emptyReadiness);
  const [stage, setStage] = useState<"review" | "vbk">("review");
  const [input, setInput] = useState("");
  const [createInput, setCreateInput] = useState<CreateProductInput>(initialInput);
  const [creating, setCreating] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);
  const [loading, setLoading] = useState(false);

  const [basicInfoDraft, setBasicInfoDraft] = useState<Record<string, string>>({});
  const [basicInfoSaving, setBasicInfoSaving] = useState<string | null>(null);
  const [basicInfoErrors, setBasicInfoErrors] = useState<Record<string, string>>({});
  const [basicInfoButlerDefault, setBasicInfoButlerDefault] = useState<ContactCardSelection | null>(null);
  const [basicInfoServicePhone, setBasicInfoServicePhone] = useState<string | null>(null);
  const [basicInfoButlerLoadedForLocalProductId, setBasicInfoButlerLoadedForLocalProductId] = useState<string | null>(null);

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  const [justConfirmedTaskId, setJustConfirmedTaskId] = useState<string | null>(null);
  const [resolvingVehicleTaskId, setResolvingVehicleTaskId] = useState<string | null>(null);
  const [refreshingIssues, setRefreshingIssues] = useState(false);
  const [navigatingSection, setNavigatingSection] = useState<string | null>(null);
  const [retryingPhase, setRetryingPhase] = useState<string | null>(null);
  const [stoppingAutomation, setStoppingAutomation] = useState(false);

  return {
    product, setProduct,
    activeLocalProductId, setActiveLocalProductId,
    products, setProducts,
    readiness, setReadiness,
    stage, setStage,
    input, setInput,
    createInput, setCreateInput,
    creating, setCreating,
    savingProduct, setSavingProduct,
    loading, setLoading,
    basicInfoDraft, setBasicInfoDraft,
    basicInfoSaving, setBasicInfoSaving,
    basicInfoErrors, setBasicInfoErrors,
    basicInfoButlerDefault, setBasicInfoButlerDefault,
    basicInfoServicePhone, setBasicInfoServicePhone,
    basicInfoButlerLoadedForLocalProductId, setBasicInfoButlerLoadedForLocalProductId,
    activeTaskId, setActiveTaskId,
    verificationNote, setVerificationNote,
    justConfirmedTaskId, setJustConfirmedTaskId,
    resolvingVehicleTaskId, setResolvingVehicleTaskId,
    refreshingIssues, setRefreshingIssues,
    navigatingSection, setNavigatingSection,
    retryingPhase, setRetryingPhase,
    stoppingAutomation, setStoppingAutomation,
  };
}
