package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.SingleDoseVo;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletResponse;
import java.util.List;

@Service
public interface StreamTrService {

    int getTrInheritanceEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int i, TrInheritanceEvaluationDto trInheritanceEvaluationDto, HttpServletResponse response,List<CacheDto> cacheDtos);

    int getTrClinicalEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i ,TrClinicalEvaluationDto trClinicalEvaluationDto,HttpServletResponse response,List<CacheDto> cacheDtos);

    int getTrSafetyEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i,TrSafetyEvaluationDto trSafetyEvaluationDto,HttpServletResponse response,List<CacheDto> cacheDtos);

    int getTrTechnologyEvaluationDto(DrugInfoNew drugInfoNew, String id, List<String> stringBuilder, int i, TrTechnologyEvaluationDto trTechnologyEvaluationDto, HttpServletResponse response, JSONObject jsonObjectMar,List<CacheDto> cacheDtos);

    int getTrMarketEvaluationDto(DrugInfoNew drugInfoNew, String id,List<String> stringBuilder,int i,TrMarketEvaluationDto trMarketEvaluationDto,HttpServletResponse response,  JSONObject jsonObjectMar,List<CacheDto> cacheDtos);

    double getPackagingSpecification(String packagQuantity, String singleDose, String medicationFrequency, String pack,String usg);

    double getLargeNumber(String packagQuantity , String singleDose, String usageAndDosage,String pack);

    double getSingleDose(String miniQuantity , String singleDose, String usageAndDosage, String specifications);

    double getDailyTreatmentCost (String singleDose, String medicationFrequency, String price);

    boolean isDoubleInteger(double value);










}
