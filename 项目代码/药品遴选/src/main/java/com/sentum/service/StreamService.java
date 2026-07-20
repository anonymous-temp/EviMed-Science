package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.EconomicalVo;
import com.sentum.pojo.vo.PriceVo;
import com.sentum.pojo.vo.SaveDrugPrice2;

import javax.servlet.http.HttpServletResponse;

public interface StreamService {
    JSONObject guidePanel(String drugId, String disease, String id, long userId, String userName, HttpServletResponse response);

    PriceVo economicalAnalysis(SaveDrugPrice2 currDrugFee);
    
    EconomicalVo economicalAnalysisPlus(SaveDrugPrice2 currDrugFee);

    Object guidePanelTr(String drugId, String id, String userName, HttpServletResponse response);
}
