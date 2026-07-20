package com.sentum.evidencecomprehensive.domain.vo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Description:pdf 转 pic 实体类
 */
@Data
@ApiModel("Pdf转Pic实体类")
@NoArgsConstructor
@AllArgsConstructor
public class PdfToPicVo {
    //-------------一定是最新的pdf成功转为pic之后-------------------
    /**
     * pdf to pic total pages
     */
    @ApiModelProperty("图片总页数")
    private Integer pages;
    /**
     * 第一张图片的地址
     */
    @ApiModelProperty("第一张图片地址")
    private String onePicUrl;
}
