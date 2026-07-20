package com.sentum.util;

import cn.hutool.core.util.StrUtil;
import com.sentum.pojo.DrugAndIndication;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.vo.DrugAndIndicationVo;
import org.apache.commons.lang.StringUtils;

/**
 * 将mongo实体类转化为vo类的方法类
 * @author zgm
 */
public class FormatUtil {
    /**
     * 将药品适应症吧转化为其VO类
     * @param drugAndIndication 药品适应症数据
     * @return 处理后返回前台的VO类
     */
    public static DrugAndIndicationVo indicationFormat(DrugAndIndication drugAndIndication){
        DrugAndIndicationVo drugAndIndicationVo = new DrugAndIndicationVo();
        //id
        drugAndIndicationVo.setId(drugAndIndication.getId());
        //返回前台的标题 = 药品名称 + 药品厂家
        StringBuilder title = new StringBuilder();
        StringBuilder name = new StringBuilder();
        if (StringUtils.isNotBlank(drugAndIndication.getDrugName())){
            title.append(drugAndIndication.getDrugName());
            name.append(drugAndIndication.getDrugName());
        }
        //规格
        if (StringUtils.isNotBlank(drugAndIndication.getSpecifications())){
            drugAndIndicationVo.setSpecifications(drugAndIndication.getSpecifications());
            name.append("-").append(drugAndIndication.getSpecifications());
        }else {
            drugAndIndicationVo.setSpecifications("暂无");
        }
        if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())){
            title.append("-").append(drugAndIndication.getManufacturer());
            name.append("-").append(drugAndIndication.getManufacturer());
        }
        drugAndIndicationVo.setTitle(title.toString());
        drugAndIndicationVo.setName(name.toString());
        //转换比
        drugAndIndicationVo.setConversionRate("暂无");
        //适应症
        String indication = drugAndIndication.getIndication();
        if (StringUtils.isNotBlank(indication)){
            indication = indication.replaceAll("br/>br/>", "<br/><br/>");
            drugAndIndicationVo.setIndication(indication);
        }else {
            drugAndIndicationVo.setIndication("");
        }
        return drugAndIndicationVo;
    }

    /**
     * 将药品适应症吧转化为其VO类
     * @param drugAndIndication 药品适应症数据
     * @return 处理后返回前台的VO类
     */
    public static DrugAndIndicationVo indicationFormatV2(DrugInfoNew drugAndIndication){
        DrugAndIndicationVo drugAndIndicationVo = new DrugAndIndicationVo();
        //id
        drugAndIndicationVo.setId(drugAndIndication.getId());
        //返回前台的标题 = 药品名称 + 药品厂家
        StringBuilder title = new StringBuilder();
        StringBuilder name = new StringBuilder();
        if (StringUtils.isNotBlank(drugAndIndication.getDrugName())){
            title.append(drugAndIndication.getDrugName());
            name.append(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""));
        }
        //规格
        if (StringUtils.isNotBlank(drugAndIndication.getSpecifications())){
            drugAndIndicationVo.setSpecifications(drugAndIndication.getSpecifications());
            name.append("-").append(drugAndIndication.getSpecifications().replaceAll("<span>", "").replaceAll("</span>", ""));
        }else {
            drugAndIndicationVo.setSpecifications("暂无");
        }
        if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())){
            title.append("-").append(drugAndIndication.getManufacturer());
            name.append("-").append(drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
        }
        drugAndIndicationVo.setTitle(title.toString());
        drugAndIndicationVo.setName(name.toString());
        //商品
        drugAndIndicationVo.setCommodityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameZh())?drugAndIndication.getCommunityNameZh():"");
        drugAndIndicationVo.setCommodityNameEn(StrUtil.isNotBlank(drugAndIndication.getCommunityNameEn())?drugAndIndication.getCommunityNameEn():"");
        //转换比
        drugAndIndicationVo.setConversionRate("暂无");
        //适应症
        String indication = drugAndIndication.getIndications();
        if (StringUtils.isNotBlank(indication)){
            indication = indication.replaceAll("br/>br/>", "<br/><br/>");
            drugAndIndicationVo.setIndication(indication);
        }else {
            drugAndIndicationVo.setIndication("暂无");
        }
        if (StringUtils.isNotBlank(drugAndIndication.getPdf())){
            drugAndIndicationVo.setUrl("https://image.evimed.com/pmc/instruction_for_select/"+drugAndIndication.getPdf());
            drugAndIndicationVo.setUrlSuffix(drugAndIndication.getPdf());
        }else {
            drugAndIndicationVo.setUrl("");
        }
        return drugAndIndicationVo;
    }
}
