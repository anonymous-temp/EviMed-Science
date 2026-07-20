package com.sentum.service;

import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.*;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public interface TraditionalGptAppService {

    int getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder,int i,TrInheritanceEvaluationDto trInheritanceEvaluationDto);

    int  getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i ,TrClinicalEvaluationDto trClinicalEvaluationDto);

    int getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i,TrSafetyEvaluationDto trSafetyEvaluationDto);

    int  getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i,TrTechnologyEvaluationDto trTechnologyEvaluationDto);

    int getTrMarketEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i,TrMarketEvaluationDto trMarketEvaluationDto);
}
