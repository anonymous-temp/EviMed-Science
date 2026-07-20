package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.DrugPriceDto;
import org.springframework.stereotype.Service;

@Service
public interface TraditionalMedicineService {
    
    Object getDataTalPuls(String disease, String searchId, String drugIds);

    Object guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId);

    Object guideOnAnalysisV2(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId);
    
    Object guideOnAnalysisV2App(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId);

    Object guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId);

    Object guidePanelApp(String id, String priceId, String drugId, String searchId);
    
    JSONObject guideOnline(String id);

    Object guidePanel(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId);
    
    String saveDrugPrice(DrugPriceDto saveDrugPriceDto) ;
    
    Object getDataTalPulsV2( String searchId, String drugIds);
}
